-- Roles
CREATE TYPE public.app_role AS ENUM ('owner', 'admin', 'user');

-- Customers (website + Telegram). Telegram-only customers have no login.
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_uid text UNIQUE,
  auth_user_id uuid UNIQUE,
  email text,
  name text NOT NULL DEFAULT 'User',
  phone text,
  ref_code text UNIQUE,
  ref_by text,
  used_ref text,
  ref_bonus_done boolean NOT NULL DEFAULT false,
  ref_earned numeric(14,4) NOT NULL DEFAULT 0,
  wallet numeric(14,4) NOT NULL DEFAULT 0 CHECK (wallet >= 0),
  total_deposit numeric(14,4) NOT NULL DEFAULT 0,
  telegram_chat_id bigint UNIQUE,
  telegram_username text,
  source text,
  api_key text UNIQUE,
  api_enabled boolean NOT NULL DEFAULT false,
  used_coupons jsonb NOT NULL DEFAULT '{}'::jsonb,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_email_idx ON public.customers (lower(email));
GRANT SELECT, UPDATE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('owner','admin'))
$$;

CREATE POLICY "own roles readable" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_staff(auth.uid()));

CREATE POLICY "customer reads self" ON public.customers FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR public.is_staff(auth.uid()));
CREATE POLICY "staff update customers" ON public.customers FOR UPDATE TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
-- Customers may only change safe fields, through this function.
CREATE OR REPLACE FUNCTION public.update_my_profile(_name text, _phone text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.customers SET name = COALESCE(NULLIF(trim(_name),''), name), phone = _phone, updated_at = now()
  WHERE auth_user_id = auth.uid();
$$;
REVOKE EXECUTE ON FUNCTION public.update_my_profile(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_profile(text, text) TO authenticated;

-- Wallet history
CREATE TABLE public.wallet_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'Adjustment',
  amount numeric(14,4) NOT NULL DEFAULT 0,
  description text,
  by_email text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_history_customer_idx ON public.wallet_history (customer_id, created_at DESC);
GRANT SELECT ON public.wallet_history TO authenticated;
GRANT ALL ON public.wallet_history TO service_role;
ALTER TABLE public.wallet_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "history own or staff" ON public.wallet_history FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()) OR customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));

-- Customer alerts
CREATE TABLE public.customer_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  msg text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_alerts_idx ON public.customer_alerts (customer_id, created_at DESC);
GRANT SELECT, DELETE ON public.customer_alerts TO authenticated;
GRANT ALL ON public.customer_alerts TO service_role;
ALTER TABLE public.customer_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alerts own or staff" ON public.customer_alerts FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()) OR customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "alerts delete own" ON public.customer_alerts FOR DELETE TO authenticated
  USING (customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));

-- Products (public catalogue columns only; stock lives in product_stock)
CREATE TABLE public.products (
  id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  description text,
  price numeric(14,4) NOT NULL DEFAULT 0,
  bot_price numeric(14,4),
  api_price numeric(14,4),
  type text,
  delivery text NOT NULL DEFAULT 'manual',
  link text,
  logo text,
  hidden boolean NOT NULL DEFAULT false,
  hide_web boolean NOT NULL DEFAULT false,
  hide_bot boolean NOT NULL DEFAULT false,
  sold_out boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT false,
  sales_count integer NOT NULL DEFAULT 0,
  stock_count integer NOT NULL DEFAULT 0,
  provider text,
  provider_name text,
  supplier_id text,
  supplier_price numeric(14,4),
  supplier_stock integer,
  supplier_synced_at timestamptz,
  markup numeric(8,2),
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.products TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "visible products public" ON public.products FOR SELECT TO anon, authenticated
  USING (NOT hidden OR public.is_staff(auth.uid()));
CREATE POLICY "staff write products" ON public.products FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Private stock: server + staff only
CREATE TABLE public.product_stock (
  id bigserial PRIMARY KEY,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_stock_product_idx ON public.product_stock (product_id, id);
GRANT SELECT, INSERT, DELETE ON public.product_stock TO authenticated;
GRANT ALL ON public.product_stock TO service_role;
GRANT USAGE ON SEQUENCE public.product_stock_id_seq TO authenticated, service_role;
ALTER TABLE public.product_stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff stock" ON public.product_stock FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE public.used_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id text NOT NULL,
  content text NOT NULL,
  order_id text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX used_stock_product_idx ON public.used_stock (product_id, created_at DESC);
GRANT SELECT ON public.used_stock TO authenticated;
GRANT ALL ON public.used_stock TO service_role;
ALTER TABLE public.used_stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff used stock" ON public.used_stock FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- Keep stock_count / sold_out in sync
CREATE OR REPLACE FUNCTION public.sync_stock_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pid text := COALESCE(NEW.product_id, OLD.product_id); n int;
BEGIN
  SELECT count(*) INTO n FROM public.product_stock WHERE product_id = pid;
  UPDATE public.products SET stock_count = n,
    sold_out = CASE WHEN delivery = 'auto' THEN n = 0 ELSE sold_out END,
    updated_at = now()
  WHERE id = pid;
  RETURN NULL;
END $$;
CREATE TRIGGER product_stock_count AFTER INSERT OR DELETE ON public.product_stock
  FOR EACH ROW EXECUTE FUNCTION public.sync_stock_count();

-- Reviews
CREATE TABLE public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  name text,
  rating int NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.reviews TO anon, authenticated;
GRANT INSERT, DELETE ON public.reviews TO authenticated;
GRANT ALL ON public.reviews TO service_role;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reviews public" ON public.reviews FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "reviews insert own" ON public.reviews FOR INSERT TO authenticated
  WITH CHECK (customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "reviews staff delete" ON public.reviews FOR DELETE TO authenticated USING (public.is_staff(auth.uid()));

-- Orders
CREATE TABLE public.orders (
  id text PRIMARY KEY,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  email text,
  status text NOT NULL DEFAULT 'Pending',
  total numeric(14,4) NOT NULL DEFAULT 0,
  coupon text,
  coupon_discount numeric(14,4) NOT NULL DEFAULT 0,
  source text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery jsonb,
  note text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_idx ON public.orders (customer_id, created_at DESC);
CREATE INDEX orders_created_idx ON public.orders (created_at DESC);
GRANT SELECT, UPDATE ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders own or staff" ON public.orders FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()) OR customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "staff update orders" ON public.orders FOR UPDATE TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Settings: public vs secret split
CREATE TABLE public.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_public boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.settings TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public settings" ON public.settings FOR SELECT TO anon, authenticated
  USING (is_public OR public.is_staff(auth.uid()));
CREATE POLICY "staff write settings" ON public.settings FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Notifications (store-wide notices)
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msg text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.notifications TO anon, authenticated;
GRANT INSERT, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notices public" ON public.notifications FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "staff notices" ON public.notifications FOR ALL TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Payments and deposits (server-only writes; staff reads)
CREATE TABLE public.payments (
  id text PRIMARY KEY,               -- txid / pay_x / plink_x
  kind text NOT NULL,                -- crypto | razorpay_payment | razorpay_claim | razorpay_link | binance
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  amount_usd numeric(14,4),
  status text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_kind_idx ON public.payments (kind, created_at DESC);
GRANT SELECT ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff payments" ON public.payments FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- Manual deposit / withdraw requests
CREATE TABLE public.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  kind text,
  amount numeric(14,4),
  status text NOT NULL DEFAULT 'pending',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.requests TO authenticated;
GRANT ALL ON public.requests TO service_role;
ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "requests own or staff" ON public.requests FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()) OR customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "requests insert own" ON public.requests FOR INSERT TO authenticated
  WITH CHECK (status = 'pending' AND customer_id IN (SELECT id FROM public.customers WHERE auth_user_id = auth.uid()));
CREATE POLICY "staff update requests" ON public.requests FOR UPDATE TO authenticated
  USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Push subscriptions
CREATE TABLE public.push_subscriptions (
  id text PRIMARY KEY,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.push_subscriptions TO service_role;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Bot-internal state (Telegram links, states, support threads, emoji, caches): server only
CREATE TABLE public.kv_store (
  path text PRIMARY KEY,
  value jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kv_store_prefix_idx ON public.kv_store (path text_pattern_ops);
GRANT ALL ON public.kv_store TO service_role;
ALTER TABLE public.kv_store ENABLE ROW LEVEL SECURITY;

-- Atomic wallet change (server only)
CREATE OR REPLACE FUNCTION public.wallet_adjust(_customer uuid, _delta numeric, _type text, _desc text, _by text DEFAULT NULL, _extra jsonb DEFAULT '{}'::jsonb)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE bal numeric;
BEGIN
  UPDATE public.customers SET wallet = wallet + _delta, updated_at = now()
   WHERE id = _customer AND wallet + _delta >= 0
   RETURNING wallet INTO bal;
  IF bal IS NULL THEN RAISE EXCEPTION 'insufficient_balance'; END IF;
  INSERT INTO public.wallet_history (customer_id, type, amount, description, by_email, extra)
  VALUES (_customer, _type, _delta, _desc, _by, COALESCE(_extra,'{}'::jsonb));
  RETURN bal;
END $$;
REVOKE EXECUTE ON FUNCTION public.wallet_adjust(uuid, numeric, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_adjust(uuid, numeric, text, text, text, jsonb) TO service_role;

-- Atomically claim N stock items (server only)
CREATE OR REPLACE FUNCTION public.claim_stock(_product text, _qty int, _order text, _email text)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE items text[];
BEGIN
  WITH picked AS (
    SELECT id, content FROM public.product_stock WHERE product_id = _product
    ORDER BY id LIMIT _qty FOR UPDATE SKIP LOCKED
  ), del AS (
    DELETE FROM public.product_stock s USING picked WHERE s.id = picked.id RETURNING picked.content
  )
  SELECT array_agg(content) INTO items FROM del;
  IF items IS NULL OR array_length(items,1) < _qty THEN RAISE EXCEPTION 'not_enough_stock'; END IF;
  INSERT INTO public.used_stock (product_id, content, order_id, email)
    SELECT _product, unnest(items), _order, _email;
  RETURN items;
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_stock(text, int, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stock(text, int, text, text) TO service_role;

-- Claim a payment exactly once (server only)
CREATE OR REPLACE FUNCTION public.claim_payment(_id text, _kind text, _customer uuid, _usd numeric, _data jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.payments (id, kind, customer_id, amount_usd, status, data)
  VALUES (_id, _kind, _customer, _usd, 'claimed', COALESCE(_data,'{}'::jsonb));
  RETURN true;
EXCEPTION WHEN unique_violation THEN RETURN false;
END $$;
REVOKE EXECUTE ON FUNCTION public.claim_payment(text, text, uuid, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment(text, text, uuid, numeric, jsonb) TO service_role;

-- Link a new login to an existing customer by email, or create one; owners get roles
CREATE OR REPLACE FUNCTION public.handle_new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid;
BEGIN
  SELECT id INTO cid FROM public.customers
   WHERE auth_user_id IS NULL AND lower(email) = lower(NEW.email)
   ORDER BY wallet DESC LIMIT 1;
  IF cid IS NOT NULL THEN
    UPDATE public.customers SET auth_user_id = NEW.id, updated_at = now() WHERE id = cid;
  ELSE
    INSERT INTO public.customers (auth_user_id, email, name, source, ref_code)
    VALUES (NEW.id, NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1), 'User'),
      'web', upper(substr(md5(NEW.id::text),1,8)));
  END IF;
  IF lower(NEW.email) IN ('adithyanbraj@gmail.com') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id,'owner'),(NEW.id,'admin') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

ALTER PUBLICATION supabase_realtime ADD TABLE public.customers, public.wallet_history, public.customer_alerts, public.notifications, public.products, public.orders;