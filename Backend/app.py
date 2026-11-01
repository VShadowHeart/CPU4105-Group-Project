import os
import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


# ---------------------------------------------------------------------------
# DB connection
# ---------------------------------------------------------------------------
def get_db_connection():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "db"),
        database=os.environ.get("DB_NAME", "flytech_energy"),
        user=os.environ.get("DB_USER", "flytech_user"),
        password=os.environ.get("DB_PASSWORD", "flytech_pass"),
        port=os.environ.get("DB_PORT", 5432),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def verify_table_exists(cur, name):
    """Return True if `name` is a table or view in the public schema."""
    cur.execute(
        """
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = %s
        UNION ALL
        SELECT 1
        FROM information_schema.views
        WHERE table_schema = 'public' AND table_name = %s
        LIMIT 1;
        """,
        (name, name),
    )
    return cur.fetchone() is not None


def get_primary_key_columns(cur, table_name):
    """Return list of PK column names for a table (empty if none)."""
    cur.execute(
        """
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.indisprimary
          AND c.relname = %s
          AND n.nspname = 'public'
        ORDER BY array_position(i.indkey, a.attnum);
        """,
        (table_name,),
    )
    return [row[0] for row in cur.fetchall()]


def log_audit(cur, user_id, event_type, details):
    """Insert a row into audit_logs inside a SAVEPOINT — never breaks the main flow.

    NOTE: Wallet balance changes are already audited by the DB trigger
    `trg_audit_wallet`. Use this helper only for non-wallet events
    (e.g. LISTING_CREATED, USER_LOGIN).
    """
    try:
        cur.execute("SAVEPOINT log_audit_sp")
        cur.execute(
            """
            INSERT INTO "public"."audit_logs"
              ("user_id", "event_type", "log_details", "recorded_at")
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
            RETURNING audit_id;
            """,
            (user_id, event_type, details),
        )
        audit_id = cur.fetchone()[0]
        cur.execute("RELEASE SAVEPOINT log_audit_sp")
        return audit_id
    except Exception as e:
        try:
            cur.execute("ROLLBACK TO SAVEPOINT log_audit_sp")
        except Exception:
            pass
        print(f"[log_audit] WARNING: could not write audit log: {e}")
        return None


# ---------------------------------------------------------------------------
# Metadata endpoints
# ---------------------------------------------------------------------------
@app.route("/api/tables", methods=["GET"])
def get_all_tables():
    """Return all tables + views + virtual metadata endpoints."""
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute(
            """
            SELECT table_name, 'table' AS kind
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            UNION ALL
            SELECT table_name, 'view' AS kind
            FROM information_schema.views
            WHERE table_schema = 'public'
            ORDER BY table_name;
            """
        )
        tables = [{"name": row[0], "kind": row[1]} for row in cur.fetchall()]

        for t in tables:
            if t["kind"] == "table":
                try:
                    cur.execute(f'SELECT COUNT(*) FROM "{t["name"]}";')
                    t["row_count"] = cur.fetchone()[0]
                except Exception:
                    conn.rollback()
                    t["row_count"] = None

        cur.close()
        conn.close()

        metadata = [
            {"name": "foreign_keys", "kind": "meta"},
            {"name": "triggers", "kind": "meta"},
        ]
        return jsonify(tables + metadata)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# GET table data
# ---------------------------------------------------------------------------
@app.route("/api/table-data/<name>", methods=["GET"])
def get_table_data(name):
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        if name == "foreign_keys":
            cur.execute(
                """
                SELECT
                    tc.table_name,
                    kcu.column_name,
                    ccu.table_name  AS foreign_table_name,
                    ccu.column_name AS foreign_column_name,
                    tc.constraint_name
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema   = kcu.table_schema
                JOIN information_schema.constraint_column_usage AS ccu
                  ON ccu.constraint_name = tc.constraint_name
                 AND ccu.constraint_schema = tc.constraint_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema = 'public'
                ORDER BY tc.table_name, kcu.column_name;
                """
            )
        elif name == "triggers":
            cur.execute(
                """
                SELECT
                    c.relname       AS table_name,
                    t.tgname        AS trigger_name,
                    pg_get_triggerdef(t.oid) AS trigger_definition
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE NOT t.tgisinternal
                  AND n.nspname = 'public'
                ORDER BY c.relname, t.tgname;
                """
            )
        else:
            if not verify_table_exists(cur, name):
                cur.close()
                conn.close()
                return jsonify({"error": f"Table '{name}' not found"}), 404

            cur.execute(f'SELECT * FROM "{name}";')

        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchall()

        cur.close()
        conn.close()

        return jsonify({"columns": columns, "rows": rows})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# POST (insert)
# ---------------------------------------------------------------------------
@app.route("/api/table-data/<name>", methods=["POST"])
def insert_table_row(name):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        if not verify_table_exists(cur, name):
            cur.close()
            conn.close()
            return jsonify({"error": f"Table '{name}' not found"}), 404

        data = request.get_json(silent=True)
        if not data or not isinstance(data, dict):
            cur.close()
            conn.close()
            return jsonify({"error": "Invalid JSON payload"}), 400

        columns = list(data.keys())
        values = list(data.values())

        col_str = ", ".join(f'"{c}"' for c in columns)
        placeholders = ", ".join(["%s"] * len(values))
        query = (
            f'INSERT INTO "{name}" ({col_str}) '
            f"VALUES ({placeholders}) RETURNING *;"
        )

        cur.execute(query, values)
        conn.commit()
        row = cur.fetchone()
        cols = [d[0] for d in cur.description]

        cur.close()
        conn.close()
        return (
            jsonify({"message": "Row inserted successfully", "row": row, "columns": cols}),
            201,
        )
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# PUT (update) — uses actual PK columns
# ---------------------------------------------------------------------------
@app.route("/api/table-data/<name>/<path:pk_values>", methods=["PUT"])
def update_table_row(name, pk_values):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        if not verify_table_exists(cur, name):
            cur.close()
            conn.close()
            return jsonify({"error": f"Table '{name}' not found"}), 404

        pk_cols = get_primary_key_columns(cur, name)
        if not pk_cols:
            cur.close()
            conn.close()
            return jsonify({"error": f"Table '{name}' has no primary key"}), 400

        pk_vals = pk_values.split("/")
        if len(pk_vals) != len(pk_cols):
            cur.close()
            conn.close()
            return (
                jsonify(
                    {
                        "error": (
                            f"Expected {len(pk_cols)} PK value(s) "
                            f"({', '.join(pk_cols)}), got {len(pk_vals)}"
                        )
                    }
                ),
                400,
            )

        data = request.get_json(silent=True)
        if not data or not isinstance(data, dict):
            cur.close()
            conn.close()
            return jsonify({"error": "Invalid JSON payload"}), 400

        set_clauses = []
        values = []
        for col, val in data.items():
            set_clauses.append(f'"{col}" = %s')
            values.append(val)

        where_clauses = " AND ".join(f'"{c}" = %s' for c in pk_cols)
        values.extend(pk_vals)

        query = (
            f'UPDATE "{name}" SET {", ".join(set_clauses)} '
            f"WHERE {where_clauses} RETURNING *;"
        )

        cur.execute(query, values)
        conn.commit()
        row = cur.fetchone()

        if not row:
            cur.close()
            conn.close()
            return jsonify({"error": "Row not found"}), 404

        cols = [d[0] for d in cur.description]
        cur.close()
        conn.close()
        return jsonify({"message": "Row updated successfully", "row": row, "columns": cols})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# DELETE — uses actual PK columns
# ---------------------------------------------------------------------------
@app.route("/api/table-data/<name>/<path:pk_values>", methods=["DELETE"])
def delete_table_row(name, pk_values):
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        if not verify_table_exists(cur, name):
            cur.close()
            conn.close()
            return jsonify({"error": f"Table '{name}' not found"}), 404

        pk_cols = get_primary_key_columns(cur, name)
        if not pk_cols:
            cur.close()
            conn.close()
            return jsonify({"error": f"Table '{name}' has no primary key"}), 400

        pk_vals = pk_values.split("/")
        if len(pk_vals) != len(pk_cols):
            cur.close()
            conn.close()
            return (
                jsonify(
                    {
                        "error": (
                            f"Expected {len(pk_cols)} PK value(s) "
                            f"({', '.join(pk_cols)}), got {len(pk_vals)}"
                        )
                    }

                ),
                400,
            )

        where_clauses = " AND ".join(f'"{c}" = %s' for c in pk_cols)
        cur.execute(f'DELETE FROM "{name}" WHERE {where_clauses} RETURNING *;', pk_vals)
        conn.commit()
        deleted = cur.fetchone()

        if not deleted:
            cur.close()
            conn.close()
            return jsonify({"error": "Row not found"}), 404

        cur.close()
        conn.close()

        return jsonify({"message": "Row deleted successfully", "deleted": deleted})
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# WALLET — Top up
# Delegates to fn_wallet_topup() (installed in DB step 14).
# The DB trigger `trg_audit_wallet` logs the change to audit_logs.
# The DB trigger `trg_wallets_touch` refreshes updated_at.
# POST /api/wallet/topup
# Body: { "user_id": 1, "amount": 50.00 }
# ---------------------------------------------------------------------------
@app.route("/api/wallet/topup", methods=["POST"])
def wallet_topup():
    conn = None
    try:
        payload = request.get_json(silent=True) or {}
        user_id = payload.get("user_id")
        amount  = payload.get("amount")

        if user_id is None or amount is None:
            return jsonify({"error": "user_id and amount are required"}), 400

        try:
            amount = float(amount)
        except (TypeError, ValueError):
            return jsonify({"error": "amount must be numeric"}), 400

        if amount <= 0:
            return jsonify({"error": "amount must be positive"}), 400

        conn = get_db_connection()
        cur = conn.cursor()

        # Call the DB function — atomic, validated
        cur.execute(
            "SELECT * FROM fn_wallet_topup(%s, %s);",
            (user_id, amount),
        )
        result = cur.fetchone()

        if result is None:
            cur.close()
            conn.close()
            return jsonify({"error": "Top up failed"}), 400

        wallet_id, new_balance = result

        # Fetch updated_at (trigger set it)
        cur.execute(
            'SELECT user_id, balance_amount, updated_at '
            'FROM "public"."user_wallets" WHERE wallet_id = %s;',
            (wallet_id,),
        )
        wallet_row = cur.fetchone()

        conn.commit()
        cur.close()
        conn.close()

        return jsonify({
            "message": "Top up successful",
            "wallet_id":      wallet_id,
            "user_id":        wallet_row[0],
            "balance_amount": str(wallet_row[1]),
            "updated_at":     str(wallet_row[2]),
            "amount":         amount,
        }), 200
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# WALLET — Withdraw
# Delegates to fn_wallet_withdraw() (installed in DB step 14).
# POST /api/wallet/withdraw
# Body: { "user_id": 1, "amount": 50.00 }
# ---------------------------------------------------------------------------
@app.route("/api/wallet/withdraw", methods=["POST"])
def wallet_withdraw():
    conn = None
    try:
        payload = request.get_json(silent=True) or {}
        user_id = payload.get("user_id")
        amount  = payload.get("amount")

        if user_id is None or amount is None:
            return jsonify({"error": "user_id and amount are required"}), 400

        try:
            amount = float(amount)
        except (TypeError, ValueError):
            return jsonify({"error": "amount must be numeric"}), 400

        if amount <= 0:
            return jsonify({"error": "amount must be positive"}), 400

        conn = get_db_connection()
        cur = conn.cursor()

        # Call the DB function — enforces sufficient-balance check
        cur.execute(
            "SELECT * FROM fn_wallet_withdraw(%s, %s);",
            (user_id, amount),
        )
        result = cur.fetchone()

        if result is None:
            cur.close()
            conn.close()
            return jsonify({"error": "Insufficient balance"}), 400

        wallet_id, new_balance = result

        cur.execute(
            'SELECT user_id, balance_amount, updated_at '
            'FROM "public"."user_wallets" WHERE wallet_id = %s;',
            (wallet_id,),
        )
        wallet_row = cur.fetchone()

        conn.commit()
        cur.close()
        conn.close()

        return jsonify({
            "message": "Withdrawal successful",
            "wallet_id":      wallet_id,
            "user_id":        wallet_row[0],
            "balance_amount": str(wallet_row[1]),
            "updated_at":     str(wallet_row[2]),
            "amount":         amount,
        }), 200
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# LEADERBOARD — top sellers by kWh sold
# Uses fn_leaderboard() (installed in DB step 12).
# ---------------------------------------------------------------------------
@app.route("/api/leaderboard", methods=["GET"])
def leaderboard():
    try:
        limit_param = request.args.get("limit", default=5, type=int)
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("SELECT * FROM fn_leaderboard(%s);", (limit_param,))
        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchall()

        cur.close()
        conn.close()
        return jsonify({"columns": columns, "rows": rows})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# USER STATS — combined profile data
# Uses fn_get_user_stats() (installed in DB step 13).
# ---------------------------------------------------------------------------
@app.route("/api/user-stats/<int:user_id>", methods=["GET"])
def user_stats(user_id):
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("SELECT * FROM fn_get_user_stats(%s);", (user_id,))
        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchall()

        cur.close()
        conn.close()

        if not rows:
            return jsonify({"error": "User not found"}), 404

        return jsonify({"columns": columns, "row": rows[0]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# EXPIRE listings — call sp_expire_stale_listings()
# Schedule via cron / pg_cron (installed in DB step 11).
# ---------------------------------------------------------------------------
@app.route("/api/expire-listings", methods=["POST"])
def expire_listings():
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("CALL sp_expire_stale_listings();")
        conn.commit()
        cur.close()
        conn.close()
        return jsonify({"message": "Expire sweep complete"}), 200
    except Exception as e:
        if conn:
            conn.rollback()
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# BUY energy — atomic purchase via sp_buy_energy() if available,
# falls back to direct INSERT (which also triggers wallet transfer).
# POST /api/table-data/transactions still works for direct inserts.
# ---------------------------------------------------------------------------
# (No new endpoint needed — the existing POST /api/table-data/transactions
#  is sufficient because the DB triggers trg_update_wallet,
#  trg_listing_autocomplete, and trg_audit_transaction handle the rest.)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.route("/api/health", methods=["GET"])
def health():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1;")
        cur.fetchone()
        cur.close()
        conn.close()
        return jsonify({"status": "ok", "db": "connected"}), 200
    except Exception as e:
        return jsonify({"status": "error", "db": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)