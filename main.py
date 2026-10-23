from datetime import date, datetime
import sqlite3

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------- 1. App and database set-up ----------
app = FastAPI(title="GBS Corner Shop API")
DB_FILE = "shop.db"


def get_conn():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row   # lets us read columns by name
    return conn


def init_db():
    with get_conn() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            date_of_birth TEXT NOT NULL)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            stock INTEGER NOT NULL)""")


init_db()


@app.get("/")
def root():
    return {"message": "GBS Corner Shop API is running"}


# ---------- 2. Models (the shape of the JSON we accept) ----------
class ItemIn(BaseModel):
    name: str = Field(min_length=1)
    price: float = Field(gt=0)
    stock: int = Field(ge=0)


class ItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    price: float | None = Field(default=None, gt=0)
    stock: int | None = Field(default=None, ge=0)


# ---------- 3. Items: Create, Read, Update, Delete ----------
@app.get("/items")
def list_items(max_price: float | None = None):
    with get_conn() as conn:
        if max_price is None:
            rows = conn.execute("SELECT * FROM items").fetchall()
        else:
            rows = conn.execute("SELECT * FROM items WHERE price <= ?",
                                (max_price,)).fetchall()
    return [dict(r) for r in rows]


@app.get("/items/{item_id}")
def get_item(item_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM items WHERE id = ?",
                           (item_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return dict(row)


@app.post("/items", status_code=201)
def add_item(item: ItemIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO items (name, price, stock) VALUES (?, ?, ?)",
            (item.name, item.price, item.stock))
    return {"id": cur.lastrowid, **item.model_dump()}


@app.put("/items/{item_id}")
def replace_item(item_id: int, item: ItemIn):
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE items SET name = ?, price = ?, stock = ? WHERE id = ?",
            (item.name, item.price, item.stock, item_id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"id": item_id, **item.model_dump()}


@app.patch("/items/{item_id}")
def update_item(item_id: int, changes: ItemUpdate):
    fields = changes.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{name} = ?" for name in fields)
    with get_conn() as conn:
        cur = conn.execute(f"UPDATE items SET {set_clause} WHERE id = ?",
                           (*fields.values(), item_id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    return get_item(item_id)


@app.delete("/items/{item_id}")
def delete_item(item_id: int):
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"message": f"Item {item_id} deleted"}


# ---------- 4. Purchase and receipt ----------
class PurchaseLine(BaseModel):
    item_id: int
    quantity: int = Field(gt=0)


class PurchaseRequest(BaseModel):
    customer_name: str = "Walk-in customer"
    lines: list[PurchaseLine] = Field(min_length=1)


@app.post("/purchase", status_code=201)
def purchase(order: PurchaseRequest):
    receipt_lines = []
    total = 0.0
    with get_conn() as conn:   # if anything fails, nothing is saved
        for line in order.lines:
            row = conn.execute("SELECT * FROM items WHERE id = ?",
                               (line.item_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404,
                                    detail=f"Item {line.item_id} not found")
            if row["stock"] < line.quantity:
                raise HTTPException(status_code=400,
                                    detail=f"Not enough stock for {row['name']}")
            conn.execute("UPDATE items SET stock = stock - ? WHERE id = ?",
                         (line.quantity, line.item_id))
            line_total = round(row["price"] * line.quantity, 2)
            total += line_total
            receipt_lines.append({"item": row["name"],
                                  "unit_price": row["price"],
                                  "quantity": line.quantity,
                                  "line_total": line_total})
    return {
        "receipt_no": datetime.now().strftime("R%Y%m%d%H%M%S"),
        "date": datetime.now().strftime("%d/%m/%Y %H:%M"),
        "customer": order.customer_name,
        "lines": receipt_lines,
        "total": round(total, 2),
        "message": "Thank you for shopping at GBS Corner Shop!",
    }


# ---------- 5. Customers (used by the sign-up form) ----------
class CustomerIn(BaseModel):
    fullName: str = Field(min_length=2)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    dob: date


@app.post("/customers", status_code=201)
def register_customer(customer: CustomerIn):
    try:
        with get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO customers (full_name, email, date_of_birth) "
                "VALUES (?, ?, ?)",
                (customer.fullName, customer.email, customer.dob.isoformat()))
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409,
                            detail="That email is already registered")
    return {"id": cur.lastrowid, "message": "Registration successful!"}


@app.get("/customers")
def list_customers():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM customers").fetchall()
    return [dict(r) for r in rows]


# ---------- 6. Serve the front end (keep this at the very bottom) ----------
app.mount("/shop", StaticFiles(directory="frontend", html=True), name="shop")
