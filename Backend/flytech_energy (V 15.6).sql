-- Adminer 6.1.2 PostgreSQL 16.15 dump

DROP TABLE IF EXISTS "public"."audit_logs", "public"."energy_listings", "public"."generation_logs", "public"."generation_logs_2026_10", "public"."generation_logs_2026_11", "public"."generation_logs_default", "public"."transactions", "public"."user_wallets", "public"."users";

DROP FUNCTION IF EXISTS "public"."fn_audit_transaction";;
CREATE FUNCTION "public"."fn_audit_transaction" ()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "public"."audit_logs"
      (user_id, event_type, log_details, recorded_at)
    VALUES (
        NEW.consumer_id,
        'TRANSACTION_COMPLETE',
        format('Trade #%s: %s kWh transferred for %s (listing %s).',
               NEW.transaction_id, NEW.kwh_transferred,
               NEW.total_cost, NEW.listing_id),
        CURRENT_TIMESTAMP
    );
    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_audit_wallet_change";;
CREATE FUNCTION "public"."fn_audit_wallet_change" ()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.balance_amount <> NEW.balance_amount THEN
        INSERT INTO "public"."audit_logs"
          (user_id, event_type, log_details, recorded_at)
        VALUES (
            NEW.user_id,
            CASE
                WHEN NEW.balance_amount > OLD.balance_amount THEN 'WALLET_DEPOSIT'
                ELSE 'WALLET_WITHDRAW'
            END,
            format('Wallet #%s: %s -> %s (delta %s).',
                   NEW.wallet_id, OLD.balance_amount,
                   NEW.balance_amount,
                   NEW.balance_amount - OLD.balance_amount),
            CURRENT_TIMESTAMP
        );
    END IF;
    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_check_listing_available";;
CREATE FUNCTION "public"."fn_check_listing_available" ()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_status VARCHAR(50);
BEGIN
    SELECT status INTO v_status
      FROM "public"."energy_listings"
     WHERE listing_id = NEW.listing_id
       FOR UPDATE;

    IF v_status IS DISTINCT FROM 'Available' THEN
        RAISE EXCEPTION 'Listing % is not Available (current: %)',
            NEW.listing_id, COALESCE(v_status, 'MISSING');
    END IF;
    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_listing_complete_on_txn";;
CREATE FUNCTION "public"."fn_listing_complete_on_txn" ()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE "public"."energy_listings"
       SET status = 'Completed'
     WHERE listing_id = NEW.listing_id
       AND status IN ('Available', 'Reserved');
    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_listing_expire_check";;
CREATE FUNCTION "public"."fn_listing_expire_check" ()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'Available' AND NEW.expires_at < CURRENT_TIMESTAMP THEN
        NEW.status := 'Expired';
    END IF;
    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_no_self_purchase";;
CREATE FUNCTION "public"."fn_no_self_purchase" ()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_seller_id INTEGER;
BEGIN
    SELECT prosumer_id INTO v_seller_id
      FROM "public"."energy_listings"
     WHERE listing_id = NEW.listing_id;

    IF v_seller_id = NEW.consumer_id THEN
        RAISE EXCEPTION 'User % cannot buy their own listing %',
            NEW.consumer_id, NEW.listing_id;
    END IF;
    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_prevent_user_delete_with_active_listings";;
CREATE FUNCTION "public"."fn_prevent_user_delete_with_active_listings" ()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "public"."energy_listings"
         WHERE prosumer_id = OLD.user_id
           AND status IN ('Available', 'Reserved')
    ) THEN
        RAISE EXCEPTION 'Cannot delete user % - they have active listings',
            OLD.user_id;
    END IF;
    RETURN OLD;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_touch_updated_at";;
CREATE FUNCTION "public"."fn_touch_updated_at" ()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_transaction_wallet_update";;
CREATE FUNCTION "public"."fn_transaction_wallet_update" ()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_seller_id INTEGER;
    v_buyer_bal NUMERIC(12,2);
BEGIN
    SELECT prosumer_id INTO v_seller_id
      FROM "public"."energy_listings"
     WHERE listing_id = NEW.listing_id;

    IF v_seller_id IS NULL THEN
        RAISE EXCEPTION 'Listing % not found', NEW.listing_id;
    END IF;

    SELECT balance_amount INTO v_buyer_bal
      FROM "public"."user_wallets"
     WHERE user_id = NEW.consumer_id
       FOR UPDATE;

    IF v_buyer_bal IS NULL THEN
        RAISE EXCEPTION 'No wallet for consumer %', NEW.consumer_id;
    END IF;

    IF v_buyer_bal < NEW.total_cost THEN
        RAISE EXCEPTION 'Insufficient funds: need %, have %',
            NEW.total_cost, v_buyer_bal;
    END IF;

    UPDATE "public"."user_wallets"
       SET balance_amount = balance_amount - NEW.total_cost
     WHERE user_id = NEW.consumer_id;

    UPDATE "public"."user_wallets"
       SET balance_amount = balance_amount + NEW.total_cost
     WHERE user_id = v_seller_id;

    RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_wallet_topup";;
CREATE FUNCTION "public"."fn_wallet_topup" (
  IN "p_user_id" integer,
  IN "p_amount" numeric,
  OUT "wallet_id" integer,
  OUT "new_balance" numeric
)
RETURNS record LANGUAGE plpgsql AS $$
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    UPDATE "public"."user_wallets"
       SET balance_amount = balance_amount + p_amount
     WHERE user_id = p_user_id
     RETURNING user_wallets.wallet_id, user_wallets.balance_amount
          INTO wallet_id, new_balance;

    IF wallet_id IS NULL THEN
        RAISE EXCEPTION 'No wallet for user %', p_user_id;
    END IF;
END
$$;

DROP FUNCTION IF EXISTS "public"."fn_wallet_withdraw";;
CREATE FUNCTION "public"."fn_wallet_withdraw" (
  IN "p_user_id" integer,
  IN "p_amount" numeric,
  OUT "wallet_id" integer,
  OUT "new_balance" numeric
)
RETURNS record LANGUAGE plpgsql AS $$
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    UPDATE "public"."user_wallets"
       SET balance_amount = balance_amount - p_amount
     WHERE user_id = p_user_id
       AND balance_amount >= p_amount
     RETURNING user_wallets.wallet_id, user_wallets.balance_amount
          INTO wallet_id, new_balance;

    IF wallet_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient balance or no wallet for user %', p_user_id;
    END IF;
END
$$;

CREATE TABLE "public"."audit_logs" (
    "audit_id" serial NOT NULL,
    "user_id" integer,
    "event_type" character varying(50) NOT NULL,
    "log_details" text NOT NULL,
    "recorded_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("audit_id")
);

CREATE INDEX idx_audit_recorded_at ON "public"."audit_logs" USING btree (recorded_at DESC);

DO $$ BEGIN PERFORM setval('"public"."audit_logs_audit_id_seq"', 182); END $$;

INSERT INTO "public"."audit_logs" ("audit_id", "user_id", "event_type", "log_details", "recorded_at") VALUES
(16,	5,	'SYSTEM_STARTUP',	'Microgrid core services initialized successfully.',	'2026-10-01 08:00:00+00'),
(17,	1,	'USER_LOGIN',	'User Eleanor Vance authenticated via Web Portal.',	'2026-10-01 08:05:00+00'),
(18,	2,	'LISTING_CREATED',	'Prosumer Marcus Thorne published listing #2 (200.50 kWh).',	'2026-10-05 09:00:00+00'),
(21,	15,	'METER_CALIBRATION',	'Municipal Admin Bruce Wayne initiated remote smart meter sync.',	'2026-10-06 10:30:00+00'),
(22,	6,	'LISTING_CREATED',	'Prosumer Liam Sinclair published listing #3 (120.00 kWh).',	'2026-10-06 10:00:00+00'),
(23,	7,	'WALLET_DEPOSIT',	'Consumer Sophie Mercer deposited funds into wallet balance.',	'2026-10-06 11:00:00+00'),
(24,	8,	'LISTING_CREATED',	'Prosumer Oliver Queen published listing #4 (300.00 kWh).',	'2026-10-06 11:00:00+00'),
(26,	5,	'SECURITY_AUDIT',	'Automated compliance check passed with zero anomalies.',	'2026-10-08 00:00:00+00'),
(27,	13,	'LISTING_CREATED',	'Prosumer Victor Fries published listing #6 (250.00 kWh).',	'2026-10-07 13:00:00+00'),
(29,	15,	'POLICY_UPDATE',	'Tariff cap thresholds updated by municipal governance.',	'2026-10-09 14:00:00+00'),
(30,	5,	'SYSTEM_BACKUP',	'Automated daily database snapshot completed.',	'2026-10-10 00:00:00+00'),
(85,	3,	'LISTING_CREATED',	'Chris Hemsworth published 2 listings (80.00 kWh, 45.50 kWh).',	'2026-10-21 11:24:38+00'),
(86,	4,	'LISTING_CREATED',	'Robert DowneyJr published a listing (120.00 kWh).',	'2026-10-21 11:24:38+00'),
(87,	5,	'LISTING_CREATED',	'Scarlett Johansson published a listing (200.00 kWh).',	'2026-10-21 11:24:38+00'),
(88,	7,	'LISTING_CREATED',	'Brie Larson published a listing (95.00 kWh).',	'2026-10-21 11:24:38+00'),
(89,	9,	'LISTING_CREATED',	'Josh Brolin published a listing (110.00 kWh).',	'2026-10-21 11:24:38+00'),
(90,	10,	'LISTING_CREATED',	'Jeremy Renner published 2 listings (75.00 kWh, 60.00 kWh).',	'2026-10-21 11:24:38+00'),
(91,	12,	'LISTING_CREATED',	'Peter Foley published a listing (140.00 kWh).',	'2026-10-21 11:24:38+00'),
(92,	14,	'LISTING_CREATED',	'Benedict Wong published a listing (100.00 kWh).',	'2026-10-21 11:24:38+00'),
(93,	15,	'LISTING_CREATED',	'Bruce Wayne published 2 more listings (90.00 kWh, 65.00 kWh).',	'2026-10-21 11:24:38+00'),
(100,	3,	'WALLET_DEPOSIT',	'Wallet #3: 98.25 -> 100.00 (delta 1.75).',	'2026-10-21 11:32:41+00'),
(101,	7,	'WALLET_DEPOSIT',	'Wallet #7: 82.67 -> 100.00 (delta 17.33).',	'2026-10-21 11:32:41+00'),
(150,	2,	'TRANSACTION_COMPLETE',	'Trade #113: 25.00 kWh transferred for 3.75 (listing 62).',	'2026-10-21 11:40:32+00'),
(151,	2,	'WALLET_WITHDRAW',	'Wallet #2: 911.25 -> 907.50 (delta -3.75).',	'2026-10-21 11:40:32+00'),
(152,	15,	'WALLET_DEPOSIT',	'Wallet #15: 2250.00 -> 2253.75 (delta 3.75).',	'2026-10-21 11:40:32+00'),
(153,	5,	'TRANSACTION_COMPLETE',	'Trade #114: 45.50 kWh transferred for 6.83 (listing 64).',	'2026-10-21 11:40:32+00'),
(154,	5,	'WALLET_WITHDRAW',	'Wallet #5: 1500.00 -> 1493.17 (delta -6.83).',	'2026-10-21 11:40:32+00'),
(155,	3,	'WALLET_DEPOSIT',	'Wallet #3: 100.00 -> 106.83 (delta 6.83).',	'2026-10-21 11:40:32+00'),
(156,	6,	'TRANSACTION_COMPLETE',	'Trade #115: 60.00 kWh transferred for 8.40 (listing 70).',	'2026-10-21 11:40:32+00'),
(157,	6,	'WALLET_WITHDRAW',	'Wallet #6: 647.05 -> 638.65 (delta -8.40).',	'2026-10-21 11:40:32+00'),
(158,	10,	'WALLET_DEPOSIT',	'Wallet #10: 415.80 -> 424.20 (delta 8.40).',	'2026-10-21 11:40:32+00'),
(159,	8,	'TRANSACTION_COMPLETE',	'Trade #116: 64.00 kWh transferred for 8.32 (listing 60).',	'2026-10-21 11:40:32+00'),
(160,	8,	'WALLET_WITHDRAW',	'Wallet #8: 1132.25 -> 1123.93 (delta -8.32).',	'2026-10-21 11:40:32+00'),
(161,	6,	'WALLET_DEPOSIT',	'Wallet #6: 638.65 -> 646.97 (delta 8.32).',	'2026-10-21 11:40:32+00'),
(162,	10,	'TRANSACTION_COMPLETE',	'Trade #117: 65.00 kWh transferred for 8.45 (listing 104).',	'2026-10-21 11:40:32+00'),
(163,	10,	'WALLET_WITHDRAW',	'Wallet #10: 424.20 -> 415.75 (delta -8.45).',	'2026-10-21 11:40:32+00'),
(164,	15,	'WALLET_DEPOSIT',	'Wallet #15: 2253.75 -> 2262.20 (delta 8.45).',	'2026-10-21 11:40:32+00'),
(165,	13,	'TRANSACTION_COMPLETE',	'Trade #118: 60.00 kWh transferred for 10.20 (listing 13).',	'2026-10-21 11:40:32+00'),
(166,	13,	'WALLET_WITHDRAW',	'Wallet #13: 932.26 -> 922.06 (delta -10.20).',	'2026-10-21 11:40:32+00'),
(167,	1,	'WALLET_DEPOSIT',	'Wallet #1: 353.70 -> 363.90 (delta 10.20).',	'2026-10-21 11:40:32+00'),
(168,	14,	'TRANSACTION_COMPLETE',	'Trade #119: 84.31 kWh transferred for 10.96 (listing 56).',	'2026-10-21 11:40:32+00'),
(169,	14,	'WALLET_WITHDRAW',	'Wallet #14: 540.00 -> 529.04 (delta -10.96).',	'2026-10-21 11:40:32+00'),
(170,	2,	'WALLET_DEPOSIT',	'Wallet #2: 907.50 -> 918.46 (delta 10.96).',	'2026-10-21 11:40:32+00'),
(171,	15,	'TRANSACTION_COMPLETE',	'Trade #120: 80.00 kWh transferred for 11.20 (listing 63).',	'2026-10-21 11:40:32+00'),
(172,	15,	'WALLET_WITHDRAW',	'Wallet #15: 2262.20 -> 2251.00 (delta -11.20).',	'2026-10-21 11:40:32+00'),
(173,	3,	'WALLET_DEPOSIT',	'Wallet #3: 106.83 -> 118.03 (delta 11.20).',	'2026-10-21 11:40:32+00'),
(174,	12,	'TRANSACTION_COMPLETE',	'Trade #121: 173.17 kWh transferred for 20.78 (listing 16).',	'2026-10-21 12:06:02.158605+00'),
(175,	12,	'WALLET_WITHDRAW',	'Wallet #12: 612.71 -> 591.93 (delta -20.78).',	'2026-10-21 12:06:02.158605+00'),
(176,	2,	'WALLET_DEPOSIT',	'Wallet #2: 918.46 -> 939.24 (delta 20.78).',	'2026-10-21 12:06:02.158605+00'),
(177,	12,	'WALLET_DEPOSIT',	'Wallet #12: 591.93 -> 641.93 (delta 50.00).',	'2026-10-21 12:13:13.672+00'),
(178,	12,	'WALLET_WITHDRAW',	'Wallet #12: 641.93 -> 591.93 (delta -50.00).',	'2026-10-21 12:13:18.862803+00'),
(179,	1,	'WALLET_DEPOSIT',	'Wallet #1: 363.90 -> 413.90 (delta 50.00).',	'2026-10-21 14:31:57.230524+00'),
(180,	1,	'WALLET_WITHDRAW',	'Wallet #1: 413.90 -> 363.90 (delta -50.00).',	'2026-10-21 14:32:02.071869+00'),
(181,	1,	'WALLET_DEPOSIT',	'Wallet #1: 363.90 -> 413.90 (delta 50.00).',	'2026-10-21 14:34:20.436039+00'),
(182,	1,	'WALLET_WITHDRAW',	'Wallet #1: 413.90 -> 363.90 (delta -50.00).',	'2026-10-21 14:34:24.879194+00');

CREATE TABLE "public"."energy_listings" (
    "listing_id" serial NOT NULL,
    "prosumer_id" integer NOT NULL,
    "energy_amount_kwh" numeric NOT NULL,
    "price_per_kwh" numeric NOT NULL,
    "status" character varying(50) DEFAULT 'Available' NOT NULL,
    "expires_at" timestamptz NOT NULL,
    "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "energy_listings_pkey" PRIMARY KEY ("listing_id"),
    CONSTRAINT "energy_amount_positive" CHECK (((energy_amount_kwh > (0)::numeric))),
    CONSTRAINT "price_positive" CHECK (((price_per_kwh > (0)::numeric))),
    CONSTRAINT "energy_listings_status_check" CHECK ((((status)::text = ANY (ARRAY[('Available'::character varying)::text, ('Reserved'::character varying)::text, ('Completed'::character varying)::text, ('Expired'::character varying)::text]))))
);

CREATE INDEX idx_listings_status_available ON "public"."energy_listings" USING btree (status, expires_at) WHERE ((status)::text = 'Available'::text);

CREATE INDEX idx_listings_prosumer_status ON "public"."energy_listings" USING btree (prosumer_id, status);

DO $$ BEGIN PERFORM setval('"public"."energy_listings_listing_id_seq"', 106); END $$;

INSERT INTO "public"."energy_listings" ("listing_id", "prosumer_id", "energy_amount_kwh", "price_per_kwh", "status", "expires_at", "created_at") VALUES
(1,	1,	150.00,	0.15,	'Completed',	'2026-10-10 18:00:00+00',	'2026-10-05 08:00:00+00'),
(2,	2,	200.50,	0.14,	'Completed',	'2026-10-10 18:00:00+00',	'2026-10-05 09:00:00+00'),
(3,	6,	120.00,	0.16,	'Completed',	'2026-10-15 18:00:00+00',	'2026-10-06 10:00:00+00'),
(4,	8,	300.00,	0.13,	'Completed',	'2026-10-15 18:00:00+00',	'2026-10-06 11:00:00+00'),
(5,	11,	85.50,	0.15,	'Completed',	'2026-10-08 18:00:00+00',	'2026-10-07 12:00:00+00'),
(6,	13,	250.00,	0.12,	'Completed',	'2026-10-16 18:00:00+00',	'2026-10-07 13:00:00+00'),
(7,	1,	95.00,	0.15,	'Expired',	'2026-10-08 12:00:00+00',	'2026-10-01 08:00:00+00'),
(8,	2,	175.00,	0.14,	'Completed',	'2026-10-18 18:00:00+00',	'2026-10-08 09:00:00+00'),
(9,	6,	110.00,	0.16,	'Completed',	'2026-10-09 18:00:00+00',	'2026-10-08 10:00:00+00'),
(10,	8,	220.00,	0.13,	'Available',	'2026-10-20 18:00:00+00',	'2026-10-08 11:00:00+00'),
(11,	11,	130.00,	0.15,	'Reserved',	'2026-10-21 18:00:00+00',	'2026-10-09 12:00:00+00'),
(12,	13,	190.00,	0.12,	'Available',	'2026-10-21 18:00:00+00',	'2026-10-09 13:00:00+00'),
(13,	1,	60.00,	0.17,	'Completed',	'2026-10-22 18:00:00+00',	'2026-10-10 08:00:00+00'),
(14,	2,	140.00,	0.14,	'Available',	'2026-10-22 18:00:00+00',	'2026-10-10 09:00:00+00'),
(15,	6,	310.00,	0.13,	'Available',	'2026-10-25 18:00:00+00',	'2026-10-10 10:00:00+00'),
(18,	8,	151.07,	0.17,	'Available',	'2026-10-15 10:28:53+00',	'2026-10-12 10:28:53+00'),
(19,	1,	166.12,	0.17,	'Available',	'2026-10-15 10:29:53+00',	'2026-10-12 10:29:53+00'),
(20,	2,	163.60,	0.17,	'Available',	'2026-10-15 10:30:23+00',	'2026-10-12 10:30:23+00'),
(21,	2,	163.55,	0.12,	'Completed',	'2026-10-15 10:30:53+00',	'2026-10-12 10:30:53+00'),
(22,	8,	152.78,	0.17,	'Available',	'2026-10-15 10:31:38+00',	'2026-10-12 10:31:38+00'),
(23,	1,	107.82,	0.13,	'Available',	'2026-10-15 10:32:23+00',	'2026-10-12 10:32:23+00'),
(25,	11,	200.97,	0.18,	'Available',	'2026-10-15 10:35:48+00',	'2026-10-12 10:35:48+00'),
(26,	11,	132.76,	0.14,	'Available',	'2026-10-15 10:37:48+00',	'2026-10-12 10:37:48+00'),
(27,	6,	132.27,	0.16,	'Available',	'2026-10-15 10:38:49+00',	'2026-10-12 10:38:49+00'),
(28,	1,	199.36,	0.12,	'Completed',	'2026-10-15 10:39:04+00',	'2026-10-12 10:39:04+00'),
(31,	13,	202.07,	0.13,	'Available',	'2026-10-15 10:42:27+00',	'2026-10-12 10:42:27+00'),
(37,	8,	137.10,	0.17,	'Available',	'2026-10-15 10:47:45+00',	'2026-10-12 10:47:45+00'),
(39,	8,	222.65,	0.11,	'Completed',	'2026-10-15 10:50:31+00',	'2026-10-12 10:50:31+00'),
(41,	6,	131.62,	0.13,	'Available',	'2026-10-15 10:51:46+00',	'2026-10-12 10:51:46+00'),
(45,	13,	187.22,	0.15,	'Available',	'2026-10-15 10:54:31+00',	'2026-10-12 10:54:31+00'),
(46,	13,	107.85,	0.11,	'Completed',	'2026-10-15 10:55:32+00',	'2026-10-12 10:55:32+00'),
(48,	8,	197.17,	0.13,	'Available',	'2026-10-15 10:57:47+00',	'2026-10-12 10:57:47+00'),
(50,	1,	228.79,	0.13,	'Available',	'2026-10-15 10:59:02+00',	'2026-10-12 10:59:02+00'),
(51,	8,	170.58,	0.11,	'Completed',	'2026-10-15 10:59:17+00',	'2026-10-12 10:59:17+00'),
(54,	2,	124.29,	0.15,	'Available',	'2026-10-15 11:01:33+00',	'2026-10-12 11:01:33+00'),
(55,	2,	173.22,	0.11,	'Completed',	'2026-10-15 11:01:48+00',	'2026-10-12 11:01:48+00'),
(56,	2,	84.31,	0.13,	'Completed',	'2026-10-15 11:02:33+00',	'2026-10-12 11:02:33+00'),
(57,	1,	137.79,	0.14,	'Available',	'2026-10-15 11:02:48+00',	'2026-10-12 11:02:48+00'),
(59,	13,	193.55,	0.14,	'Available',	'2026-10-15 11:04:33+00',	'2026-10-12 11:04:33+00'),
(60,	6,	64.00,	0.13,	'Completed',	'2026-10-15 11:06:04+00',	'2026-10-12 11:06:04+00'),
(61,	13,	188.03,	0.16,	'Available',	'2026-10-15 11:06:56+00',	'2026-10-12 11:06:56+00'),
(62,	15,	25.00,	0.15,	'Completed',	'2026-10-31 10:37:00+00',	'2026-10-18 09:36:56+00'),
(63,	3,	80.00,	0.14,	'Completed',	'2026-11-15 18:00:00+00',	'2026-10-21 11:23:07+00'),
(64,	3,	45.50,	0.15,	'Completed',	'2026-11-20 18:00:00+00',	'2026-10-21 11:23:07+00'),
(65,	4,	120.00,	0.13,	'Available',	'2026-11-18 18:00:00+00',	'2026-10-21 11:23:07+00'),
(66,	5,	200.00,	0.12,	'Available',	'2026-11-25 18:00:00+00',	'2026-10-21 11:23:07+00'),
(67,	7,	95.00,	0.15,	'Available',	'2026-11-20 18:00:00+00',	'2026-10-21 11:23:07+00'),
(68,	9,	110.00,	0.14,	'Available',	'2026-11-22 18:00:00+00',	'2026-10-21 11:23:07+00'),
(69,	10,	75.00,	0.16,	'Available',	'2026-11-20 18:00:00+00',	'2026-10-21 11:23:07+00'),
(70,	10,	60.00,	0.14,	'Completed',	'2026-11-28 18:00:00+00',	'2026-10-21 11:23:07+00'),
(71,	12,	140.00,	0.13,	'Available',	'2026-11-23 18:00:00+00',	'2026-10-21 11:23:07+00'),
(72,	14,	100.00,	0.15,	'Available',	'2026-11-21 18:00:00+00',	'2026-10-21 11:23:07+00'),
(103,	15,	90.00,	0.14,	'Available',	'2026-11-26 18:00:00+00',	'2026-10-21 11:24:08+00'),
(104,	15,	65.00,	0.13,	'Completed',	'2026-11-30 18:00:00+00',	'2026-10-21 11:24:08+00'),
(105,	12,	100.00,	0.15,	'Available',	'2026-10-22 12:05:00+00',	'2026-10-21 12:05:24.686158+00'),
(16,	2,	173.17,	0.12,	'Completed',	'2026-10-15 10:27:22+00',	'2026-10-12 10:27:22+00'),
(106,	12,	100.00,	0.14,	'Available',	'2026-10-30 13:49:00+00',	'2026-10-21 12:49:11.356437+00');

DELIMITER ;;

CREATE TRIGGER "trg_listing_expire_before_update" BEFORE UPDATE ON "public"."energy_listings" FOR EACH ROW EXECUTE FUNCTION fn_listing_expire_check();;

DELIMITER ;

DROP SEQUENCE IF EXISTS "public"."generation_logs_log_id_seq1";
CREATE SEQUENCE "public"."generation_logs_log_id_seq1" INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."generation_logs" (
    "log_id" integer DEFAULT nextval('"public"."generation_logs_log_id_seq1"') NOT NULL,
    "user_id" integer NOT NULL,
    "solar_generated_kwh" numeric(10,2) NOT NULL,
    "battery_storage_level_pct" numeric(5,2) NOT NULL,
    "recorded_date" date NOT NULL,
    CONSTRAINT "generation_logs_pkey" PRIMARY KEY ("log_id", "recorded_date"),
    CONSTRAINT "battery_pct_check" CHECK ((((battery_storage_level_pct >= 0.00) AND (battery_storage_level_pct <= 100.00)))),
    CONSTRAINT "solar_non_negative" CHECK (((solar_generated_kwh >= (0)::numeric)))
)
PARTITION BY RANGE("recorded_date");

ALTER SEQUENCE "public"."generation_logs_log_id_seq1" OWNED BY "public"."generation_logs"."log_id";

INSERT INTO "public"."generation_logs" ("log_id", "user_id", "solar_generated_kwh", "battery_storage_level_pct", "recorded_date") VALUES
(58,	1,	45.20,	85.50,	'2026-10-06'),
(59,	2,	52.80,	90.00,	'2026-10-06'),
(60,	3,	38.40,	78.20,	'2026-10-06'),
(61,	4,	61.00,	95.00,	'2026-10-06'),
(62,	5,	29.50,	64.00,	'2026-10-06'),
(63,	6,	55.10,	88.50,	'2026-10-06'),
(64,	7,	47.30,	82.00,	'2026-10-06'),
(65,	8,	58.60,	91.00,	'2026-10-06'),
(66,	9,	41.20,	76.50,	'2026-10-06'),
(67,	10,	34.80,	70.00,	'2026-10-06'),
(68,	11,	49.50,	87.30,	'2026-10-06'),
(69,	12,	44.10,	84.20,	'2026-10-06'),
(70,	13,	56.40,	89.70,	'2026-10-06'),
(71,	14,	32.60,	68.00,	'2026-10-06'),
(72,	15,	25.00,	62.50,	'2026-10-06'),
(73,	1,	48.00,	92.00,	'2026-10-07'),
(74,	2,	50.20,	89.00,	'2026-10-07'),
(75,	3,	41.00,	82.50,	'2026-10-07'),
(76,	4,	59.80,	94.10,	'2026-10-07'),
(77,	5,	33.20,	70.00,	'2026-10-07'),
(78,	6,	52.00,	86.00,	'2026-10-07'),
(79,	7,	46.50,	83.00,	'2026-10-07'),
(80,	8,	61.20,	93.50,	'2026-10-07'),
(81,	9,	43.80,	79.00,	'2026-10-07'),
(82,	10,	36.50,	72.00,	'2026-10-07'),
(83,	11,	51.10,	88.00,	'2026-10-07'),
(84,	12,	45.90,	85.00,	'2026-10-07'),
(85,	13,	54.70,	90.20,	'2026-10-07'),
(86,	14,	34.30,	69.50,	'2026-10-07'),
(87,	15,	27.50,	65.00,	'2026-10-07'),
(88,	1,	46.50,	87.00,	'2026-10-08'),
(89,	2,	49.00,	91.00,	'2026-10-08'),
(90,	3,	39.90,	79.50,	'2026-10-08'),
(91,	4,	57.20,	92.00,	'2026-10-08'),
(92,	5,	31.80,	68.00,	'2026-10-08'),
(93,	6,	50.30,	84.50,	'2026-10-08'),
(94,	7,	44.70,	81.00,	'2026-10-08'),
(95,	8,	59.40,	91.50,	'2026-10-08'),
(96,	9,	42.10,	77.00,	'2026-10-08'),
(97,	10,	35.60,	71.00,	'2026-10-08'),
(98,	11,	48.90,	85.50,	'2026-10-08'),
(99,	12,	43.50,	82.00,	'2026-10-08'),
(100,	13,	53.20,	88.00,	'2026-10-08'),
(101,	14,	31.40,	67.50,	'2026-10-08'),
(102,	15,	24.80,	61.00,	'2026-10-08'),
(103,	1,	42.10,	84.00,	'2026-11-01'),
(104,	2,	47.50,	88.00,	'2026-11-01'),
(105,	3,	36.20,	76.00,	'2026-11-01'),
(106,	4,	54.80,	90.00,	'2026-11-01'),
(107,	5,	28.30,	63.00,	'2026-11-01'),
(108,	6,	48.60,	85.00,	'2026-11-01'),
(109,	7,	43.40,	81.00,	'2026-11-01'),
(110,	8,	56.70,	89.50,	'2026-11-01'),
(111,	9,	38.90,	74.50,	'2026-11-01'),
(112,	10,	32.50,	69.00,	'2026-11-01'),
(113,	11,	46.20,	84.50,	'2026-11-01'),
(114,	12,	41.80,	80.00,	'2026-11-01'),
(115,	13,	50.30,	87.00,	'2026-11-01'),
(116,	14,	29.70,	66.00,	'2026-11-01'),
(117,	15,	23.40,	60.50,	'2026-11-01'),
(118,	1,	44.60,	86.00,	'2026-11-02'),
(119,	2,	49.30,	89.50,	'2026-11-02'),
(120,	3,	38.70,	78.00,	'2026-11-02'),
(121,	4,	56.10,	91.00,	'2026-11-02'),
(122,	5,	30.20,	65.50,	'2026-11-02'),
(123,	6,	50.40,	86.00,	'2026-11-02'),
(124,	7,	45.10,	82.50,	'2026-11-02'),
(125,	8,	58.30,	90.50,	'2026-11-02'),
(126,	9,	40.60,	75.50,	'2026-11-02'),
(127,	10,	33.80,	70.00,	'2026-11-02'),
(128,	11,	47.90,	85.00,	'2026-11-02'),
(129,	12,	43.20,	81.00,	'2026-11-02'),
(130,	13,	51.70,	87.50,	'2026-11-02'),
(131,	14,	31.10,	67.00,	'2026-11-02'),
(132,	15,	25.60,	62.00,	'2026-11-02');

DROP SEQUENCE IF EXISTS "public"."generation_logs_log_id_seq";
CREATE SEQUENCE "public"."generation_logs_log_id_seq" INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."generation_logs_2026_10" (
    "log_id" integer DEFAULT nextval('"public"."generation_logs_log_id_seq"') NOT NULL,
    "user_id" integer NOT NULL,
    "solar_generated_kwh" numeric(10,2) NOT NULL,
    "battery_storage_level_pct" numeric(5,2) NOT NULL,
    "recorded_date" date NOT NULL,
    CONSTRAINT "generation_logs_2026_10_pkey" PRIMARY KEY ("log_id", "recorded_date"),
    CONSTRAINT "battery_pct_check" CHECK ((((battery_storage_level_pct >= 0.00) AND (battery_storage_level_pct <= 100.00)))),
    CONSTRAINT "solar_non_negative" CHECK (((solar_generated_kwh >= (0)::numeric)))
);

CREATE INDEX generation_logs_2026_10_user_id_recorded_date_idx ON "public"."generation_logs_2026_10" USING btree (user_id, recorded_date DESC);

DO $$ BEGIN PERFORM setval('"public"."generation_logs_log_id_seq"', 132); END $$;

INSERT INTO "public"."generation_logs_2026_10" ("log_id", "user_id", "solar_generated_kwh", "battery_storage_level_pct", "recorded_date") VALUES
(58,	1,	45.20,	85.50,	'2026-10-06'),
(59,	2,	52.80,	90.00,	'2026-10-06'),
(60,	3,	38.40,	78.20,	'2026-10-06'),
(61,	4,	61.00,	95.00,	'2026-10-06'),
(62,	5,	29.50,	64.00,	'2026-10-06'),
(63,	6,	55.10,	88.50,	'2026-10-06'),
(64,	7,	47.30,	82.00,	'2026-10-06'),
(65,	8,	58.60,	91.00,	'2026-10-06'),
(66,	9,	41.20,	76.50,	'2026-10-06'),
(67,	10,	34.80,	70.00,	'2026-10-06'),
(68,	11,	49.50,	87.30,	'2026-10-06'),
(69,	12,	44.10,	84.20,	'2026-10-06'),
(70,	13,	56.40,	89.70,	'2026-10-06'),
(71,	14,	32.60,	68.00,	'2026-10-06'),
(72,	15,	25.00,	62.50,	'2026-10-06'),
(73,	1,	48.00,	92.00,	'2026-10-07'),
(74,	2,	50.20,	89.00,	'2026-10-07'),
(75,	3,	41.00,	82.50,	'2026-10-07'),
(76,	4,	59.80,	94.10,	'2026-10-07'),
(77,	5,	33.20,	70.00,	'2026-10-07'),
(78,	6,	52.00,	86.00,	'2026-10-07'),
(79,	7,	46.50,	83.00,	'2026-10-07'),
(80,	8,	61.20,	93.50,	'2026-10-07'),
(81,	9,	43.80,	79.00,	'2026-10-07'),
(82,	10,	36.50,	72.00,	'2026-10-07'),
(83,	11,	51.10,	88.00,	'2026-10-07'),
(84,	12,	45.90,	85.00,	'2026-10-07'),
(85,	13,	54.70,	90.20,	'2026-10-07'),
(86,	14,	34.30,	69.50,	'2026-10-07'),
(87,	15,	27.50,	65.00,	'2026-10-07'),
(88,	1,	46.50,	87.00,	'2026-10-08'),
(89,	2,	49.00,	91.00,	'2026-10-08'),
(90,	3,	39.90,	79.50,	'2026-10-08'),
(91,	4,	57.20,	92.00,	'2026-10-08'),
(92,	5,	31.80,	68.00,	'2026-10-08'),
(93,	6,	50.30,	84.50,	'2026-10-08'),
(94,	7,	44.70,	81.00,	'2026-10-08'),
(95,	8,	59.40,	91.50,	'2026-10-08'),
(96,	9,	42.10,	77.00,	'2026-10-08'),
(97,	10,	35.60,	71.00,	'2026-10-08'),
(98,	11,	48.90,	85.50,	'2026-10-08'),
(99,	12,	43.50,	82.00,	'2026-10-08'),
(100,	13,	53.20,	88.00,	'2026-10-08'),
(101,	14,	31.40,	67.50,	'2026-10-08'),
(102,	15,	24.80,	61.00,	'2026-10-08');

DROP SEQUENCE IF EXISTS "public"."generation_logs_log_id_seq";
CREATE SEQUENCE "public"."generation_logs_log_id_seq" INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."generation_logs_2026_11" (
    "log_id" integer DEFAULT nextval('"public"."generation_logs_log_id_seq"') NOT NULL,
    "user_id" integer NOT NULL,
    "solar_generated_kwh" numeric(10,2) NOT NULL,
    "battery_storage_level_pct" numeric(5,2) NOT NULL,
    "recorded_date" date NOT NULL,
    CONSTRAINT "generation_logs_2026_11_pkey" PRIMARY KEY ("log_id", "recorded_date"),
    CONSTRAINT "battery_pct_check" CHECK ((((battery_storage_level_pct >= 0.00) AND (battery_storage_level_pct <= 100.00)))),
    CONSTRAINT "solar_non_negative" CHECK (((solar_generated_kwh >= (0)::numeric)))
);

CREATE INDEX generation_logs_2026_11_user_id_recorded_date_idx ON "public"."generation_logs_2026_11" USING btree (user_id, recorded_date DESC);

DO $$ BEGIN PERFORM setval('"public"."generation_logs_log_id_seq"', 132); END $$;

INSERT INTO "public"."generation_logs_2026_11" ("log_id", "user_id", "solar_generated_kwh", "battery_storage_level_pct", "recorded_date") VALUES
(103,	1,	42.10,	84.00,	'2026-11-01'),
(104,	2,	47.50,	88.00,	'2026-11-01'),
(105,	3,	36.20,	76.00,	'2026-11-01'),
(106,	4,	54.80,	90.00,	'2026-11-01'),
(107,	5,	28.30,	63.00,	'2026-11-01'),
(108,	6,	48.60,	85.00,	'2026-11-01'),
(109,	7,	43.40,	81.00,	'2026-11-01'),
(110,	8,	56.70,	89.50,	'2026-11-01'),
(111,	9,	38.90,	74.50,	'2026-11-01'),
(112,	10,	32.50,	69.00,	'2026-11-01'),
(113,	11,	46.20,	84.50,	'2026-11-01'),
(114,	12,	41.80,	80.00,	'2026-11-01'),
(115,	13,	50.30,	87.00,	'2026-11-01'),
(116,	14,	29.70,	66.00,	'2026-11-01'),
(117,	15,	23.40,	60.50,	'2026-11-01'),
(118,	1,	44.60,	86.00,	'2026-11-02'),
(119,	2,	49.30,	89.50,	'2026-11-02'),
(120,	3,	38.70,	78.00,	'2026-11-02'),
(121,	4,	56.10,	91.00,	'2026-11-02'),
(122,	5,	30.20,	65.50,	'2026-11-02'),
(123,	6,	50.40,	86.00,	'2026-11-02'),
(124,	7,	45.10,	82.50,	'2026-11-02'),
(125,	8,	58.30,	90.50,	'2026-11-02'),
(126,	9,	40.60,	75.50,	'2026-11-02'),
(127,	10,	33.80,	70.00,	'2026-11-02'),
(128,	11,	47.90,	85.00,	'2026-11-02'),
(129,	12,	43.20,	81.00,	'2026-11-02'),
(130,	13,	51.70,	87.50,	'2026-11-02'),
(131,	14,	31.10,	67.00,	'2026-11-02'),
(132,	15,	25.60,	62.00,	'2026-11-02');

DROP SEQUENCE IF EXISTS "public"."generation_logs_log_id_seq";
CREATE SEQUENCE "public"."generation_logs_log_id_seq" INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."generation_logs_default" (
    "log_id" integer DEFAULT nextval('"public"."generation_logs_log_id_seq"') NOT NULL,
    "user_id" integer NOT NULL,
    "solar_generated_kwh" numeric(10,2) NOT NULL,
    "battery_storage_level_pct" numeric(5,2) NOT NULL,
    "recorded_date" date NOT NULL,
    CONSTRAINT "generation_logs_default_pkey" PRIMARY KEY ("log_id", "recorded_date"),
    CONSTRAINT "battery_pct_check" CHECK ((((battery_storage_level_pct >= 0.00) AND (battery_storage_level_pct <= 100.00)))),
    CONSTRAINT "solar_non_negative" CHECK (((solar_generated_kwh >= (0)::numeric)))
);

CREATE INDEX generation_logs_default_user_id_recorded_date_idx ON "public"."generation_logs_default" USING btree (user_id, recorded_date DESC);

DO $$ BEGIN PERFORM setval('"public"."generation_logs_log_id_seq"', 132); END $$;


CREATE TABLE "public"."transactions" (
    "transaction_id" serial NOT NULL,
    "listing_id" integer NOT NULL,
    "consumer_id" integer NOT NULL,
    "kwh_transferred" numeric(10,2) NOT NULL,
    "total_cost" numeric(10,2) NOT NULL,
    "trade_timestamp" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "transactions_pkey" PRIMARY KEY ("transaction_id"),
    CONSTRAINT "kwh_transferred_positive" CHECK (((kwh_transferred > (0)::numeric))),
    CONSTRAINT "total_cost_positive" CHECK (((total_cost >= (0)::numeric)))
);

CREATE INDEX idx_transactions_trade_time ON "public"."transactions" USING btree (trade_timestamp DESC);

CREATE INDEX idx_transactions_consumer ON "public"."transactions" USING btree (consumer_id);

CREATE INDEX idx_txn_consumer_time ON "public"."transactions" USING btree (consumer_id, trade_timestamp DESC);

CREATE INDEX idx_txn_listing ON "public"."transactions" USING btree (listing_id);

DO $$ BEGIN PERFORM setval('"public"."transactions_transaction_id_seq"', 121); END $$;

INSERT INTO "public"."transactions" ("transaction_id", "listing_id", "consumer_id", "kwh_transferred", "total_cost", "trade_timestamp") VALUES
(1,	1,	3,	150.00,	22.50,	'2026-10-05 14:30:00+00'),
(2,	2,	4,	200.50,	28.07,	'2026-10-05 15:00:00+00'),
(3,	5,	7,	85.50,	12.83,	'2026-10-07 16:20:00+00'),
(4,	9,	9,	110.00,	17.60,	'2026-10-09 11:15:00+00'),
(77,	39,	12,	222.65,	24.49,	'2026-10-12 11:07:11+00'),
(78,	3,	9,	120.00,	19.20,	'2026-10-12 11:07:26+00'),
(79,	4,	12,	300.00,	39.00,	'2026-10-12 11:07:41+00'),
(80,	46,	1,	107.85,	11.86,	'2026-10-15 11:19:52+00'),
(81,	51,	1,	170.58,	18.76,	'2026-10-15 11:20:59+00'),
(82,	55,	1,	173.22,	19.05,	'2026-10-15 11:21:03+00'),
(83,	21,	1,	163.55,	19.63,	'2026-10-15 11:46:31+00'),
(84,	28,	1,	199.36,	23.92,	'2026-10-15 11:46:32+00'),
(85,	6,	4,	250.00,	30.00,	'2026-10-15 11:48:21+00'),
(86,	8,	11,	175.00,	24.50,	'2026-10-18 14:14:57+00'),
(113,	62,	2,	25.00,	3.75,	'2026-10-21 11:40:32+00'),
(114,	64,	5,	45.50,	6.83,	'2026-10-21 11:40:32+00'),
(115,	70,	6,	60.00,	8.40,	'2026-10-21 11:40:32+00'),
(116,	60,	8,	64.00,	8.32,	'2026-10-21 11:40:32+00'),
(117,	104,	10,	65.00,	8.45,	'2026-10-21 11:40:32+00'),
(118,	13,	13,	60.00,	10.20,	'2026-10-21 11:40:32+00'),
(119,	56,	14,	84.31,	10.96,	'2026-10-21 11:40:32+00'),
(120,	63,	15,	80.00,	11.20,	'2026-10-21 11:40:32+00'),
(121,	16,	12,	173.17,	20.78,	'2026-10-21 12:06:04+00');

DELIMITER ;;

CREATE TRIGGER "trg_audit_transaction" AFTER INSERT ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION fn_audit_transaction();;

CREATE TRIGGER "trg_listing_autocomplete" AFTER INSERT ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION fn_listing_complete_on_txn();;

CREATE TRIGGER "trg_update_wallet" AFTER INSERT ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION fn_transaction_wallet_update();;

CREATE TRIGGER "trg_check_listing_available" BEFORE INSERT ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION fn_check_listing_available();;

CREATE TRIGGER "trg_no_self_purchase" BEFORE INSERT ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION fn_no_self_purchase();;

DELIMITER ;

CREATE TABLE "public"."user_wallets" (
    "wallet_id" serial NOT NULL,
    "user_id" integer NOT NULL,
    "balance_amount" numeric(12,2) DEFAULT '0.00' NOT NULL,
    "currency" character varying(10) DEFAULT 'USD' NOT NULL,
    "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("wallet_id"),
    CONSTRAINT "balance_non_negative" CHECK (((balance_amount >= 0.00)))
);

CREATE UNIQUE INDEX user_wallets_user_id_key ON "public"."user_wallets" USING btree (user_id);

DO $$ BEGIN PERFORM setval('"public"."user_wallets_wallet_id_seq"', 15); END $$;

INSERT INTO "public"."user_wallets" ("wallet_id", "user_id", "balance_amount", "currency", "updated_at") VALUES
(3,	3,	118.03,	'USD',	'2026-10-21 11:40:32.892566+00'),
(4,	4,	251.93,	'USD',	'2026-10-15 11:48:19.646434+00'),
(5,	5,	1493.17,	'USD',	'2026-10-21 11:40:32.892566+00'),
(6,	6,	646.97,	'USD',	'2026-10-21 11:40:32.892566+00'),
(7,	7,	100.00,	'USD',	'2026-10-21 11:32:41.945852+00'),
(8,	8,	1123.93,	'USD',	'2026-10-21 11:40:32.892566+00'),
(9,	9,	193.30,	'USD',	'2026-10-12 11:07:26.323874+00'),
(10,	10,	415.75,	'USD',	'2026-10-21 11:40:32.892566+00'),
(11,	11,	6919.33,	'USD',	'2026-10-21 11:12:04.362269+00'),
(13,	13,	922.06,	'USD',	'2026-10-21 11:40:32.892566+00'),
(14,	14,	529.04,	'USD',	'2026-10-21 11:40:32.892566+00'),
(15,	15,	2251.00,	'USD',	'2026-10-21 11:40:32.892566+00'),
(2,	2,	939.24,	'USD',	'2026-10-21 12:06:02.158605+00'),
(12,	12,	591.93,	'USD',	'2026-10-21 12:13:18.862803+00'),
(1,	1,	363.90,	'USD',	'2026-10-21 14:34:24.879194+00');

DELIMITER ;;

CREATE TRIGGER "trg_audit_wallet" AFTER UPDATE ON "public"."user_wallets" FOR EACH ROW EXECUTE FUNCTION fn_audit_wallet_change();;

CREATE TRIGGER "trg_wallets_touch" BEFORE UPDATE ON "public"."user_wallets" FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();;

DELIMITER ;

CREATE TABLE "public"."users" (
    "user_id" serial NOT NULL,
    "full_name" character varying(255) NOT NULL,
    "email" character varying(255) NOT NULL,
    "role_type" character varying(50) NOT NULL,
    "meter_serial_no" character varying(100),
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "users_role_type_check" CHECK ((((role_type)::text = ANY (ARRAY[('Prosumer'::character varying)::text, ('Consumer'::character varying)::text, ('Municipal_Admin'::character varying)::text]))))
);

CREATE UNIQUE INDEX users_email_key ON "public"."users" USING btree (email);

CREATE UNIQUE INDEX users_meter_key ON "public"."users" USING btree (meter_serial_no) WHERE (meter_serial_no IS NOT NULL);

DO $$ BEGIN PERFORM setval('"public"."users_user_id_seq"', 15); END $$;

INSERT INTO "public"."users" ("user_id", "full_name", "email", "role_type", "meter_serial_no", "is_active", "created_at") VALUES
(1,	'Chris Evans',	'Chris.Evans@shadow-valentine.co.uk',	'Prosumer',	'MTR-PRJ-88410',	't',	'2026-10-01 08:00:00+00'),
(2,	'Mark Ruffalo',	'Mark.Ruffalo@shadow-valentine.co.uk',	'Prosumer',	'MTR-PRJ-88411',	't',	'2026-10-01 08:30:00+00'),
(3,	'Chris Hemsworth',	'Chris.Hemsworth@shadow-valentine.co.uk',	'Consumer',	'MTR-CNS-10293',	't',	'2026-10-01 09:00:00+00'),
(4,	'Robert DowneyJr',	'Robert.DowneyJr@shadow-valentine.co.uk',	'Consumer',	'MTR-CNS-10294',	't',	'2026-10-01 09:15:00+00'),
(5,	'Scarlett Johansson',	'Scarlett.Johansson@shadow-valentine.co.uk',	'Municipal_Admin',	NULL,	't',	'2026-10-01 09:30:00+00'),
(6,	'Paul Rudd',	'Paul.Rudd@shadow-valentine.co.uk',	'Prosumer',	'MTR-PRJ-88412',	't',	'2026-10-02 10:00:00+00'),
(7,	'Brie Larson',	'Brie.Larson@shadow-valentine.co.uk',	'Consumer',	'MTR-CNS-10295',	't',	'2026-10-02 10:30:00+00'),
(8,	'Bradley Cooper',	'Bradley.Cooper@shadow-valentine.co.uk',	'Prosumer',	'MTR-PRJ-88413',	't',	'2026-10-03 11:00:00+00'),
(9,	'Josh Brolin',	'Josh.Brolin@shadow-valentine.co.uk',	'Consumer',	'MTR-CNS-10296',	't',	'2026-10-03 11:45:00+00'),
(10,	'Jeremy Renner',	'Jeremy.Renner@shadow-valentine.co.uk',	'Consumer',	'MTR-CNS-10297',	't',	'2026-10-04 12:00:00+00'),
(11,	'Carl Hunter',	'Carl.Hunter@shadow-valentine.co.uk',	'Prosumer',	'MTR-PRJ-88414',	't',	'2026-10-04 13:20:00+00'),
(12,	'Peter Foley',	'Peter.Foley@shadow-valentine.co.uk',	'Consumer',	'MTR-CNS-10298',	't',	'2026-10-05 14:00:00+00'),
(13,	'Jon Favreau',	'Jon.Favreau@shadow-valentine.co.uk',	'Prosumer',	'MTR-PRJ-88415',	't',	'2026-10-05 15:10:00+00'),
(14,	'Benedict Wong',	'Benedict.Wong@shadow-valentine.co.uk',	'Consumer',	'MTR-CNS-10299',	't',	'2026-10-06 09:00:00+00'),
(15,	'Bruce Wayne',	'bruce.wayne@shadow-valentine.co.uk',	'Municipal_Admin',	NULL,	't',	'2026-10-06 10:00:00+00');

DELIMITER ;;

CREATE TRIGGER "trg_prevent_user_delete" BEFORE DELETE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION fn_prevent_user_delete_with_active_listings();;

DELIMITER ;

ALTER TABLE ONLY "public"."audit_logs" ADD CONSTRAINT "fk_audit_user" FOREIGN KEY (user_id) REFERENCES "public"."users"(user_id) ON DELETE SET NULL;

ALTER TABLE ONLY "public"."energy_listings" ADD CONSTRAINT "fk_listing_prosumer" FOREIGN KEY (prosumer_id) REFERENCES "public"."users"(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."generation_logs" ADD CONSTRAINT "fk_generation_user" FOREIGN KEY (user_id) REFERENCES "public"."users"(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."generation_logs_2026_10" ADD CONSTRAINT "fk_generation_user" FOREIGN KEY (user_id) REFERENCES "public"."users"(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."generation_logs_2026_11" ADD CONSTRAINT "fk_generation_user" FOREIGN KEY (user_id) REFERENCES "public"."users"(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."generation_logs_default" ADD CONSTRAINT "fk_generation_user" FOREIGN KEY (user_id) REFERENCES "public"."users"(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."transactions" ADD CONSTRAINT "fk_transaction_consumer" FOREIGN KEY (consumer_id) REFERENCES "public"."users"(user_id);
ALTER TABLE ONLY "public"."transactions" ADD CONSTRAINT "fk_transaction_listing" FOREIGN KEY (listing_id) REFERENCES "public"."energy_listings"(listing_id);

ALTER TABLE ONLY "public"."user_wallets" ADD CONSTRAINT "fk_wallet_user" FOREIGN KEY (user_id) REFERENCES "public"."users"(user_id) ON DELETE CASCADE;

-- 2026-10-21 15:28:17 UTC
