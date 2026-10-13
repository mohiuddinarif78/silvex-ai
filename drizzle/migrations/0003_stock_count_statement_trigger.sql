-- product_stock_count fired FOR EACH ROW: a bulk stock import or clear ran one
-- count(*) + UPDATE products per row (e.g. 5000 firings for a 5000-line import),
-- each bumping products.updated_at. Switch to statement-level triggers with
-- transition tables so a bulk INSERT/DELETE recomputes each affected product's
-- stock_count exactly once.

-- Recount every product referenced by the statement's changed rows.
CREATE OR REPLACE FUNCTION public.sync_stock_count_ins() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  WITH affected AS (SELECT DISTINCT product_id FROM new_stock),
  counts AS (
    SELECT a.product_id AS pid, count(s.id) AS n
    FROM affected a
    LEFT JOIN public.product_stock s ON s.product_id = a.product_id
    GROUP BY a.product_id
  )
  UPDATE public.products p
     SET stock_count = c.n,
         sold_out = CASE WHEN p.delivery = 'auto' THEN c.n = 0 ELSE p.sold_out END,
         updated_at = now()
    FROM counts c
   WHERE p.id = c.pid;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.sync_stock_count_del() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  WITH affected AS (SELECT DISTINCT product_id FROM old_stock),
  counts AS (
    SELECT a.product_id AS pid, count(s.id) AS n
    FROM affected a
    LEFT JOIN public.product_stock s ON s.product_id = a.product_id
    GROUP BY a.product_id
  )
  UPDATE public.products p
     SET stock_count = c.n,
         sold_out = CASE WHEN p.delivery = 'auto' THEN c.n = 0 ELSE p.sold_out END,
         updated_at = now()
    FROM counts c
   WHERE p.id = c.pid;
  RETURN NULL;
END $$;

-- Replace the per-row trigger with two statement-level triggers.
DROP TRIGGER IF EXISTS product_stock_count ON public.product_stock;

CREATE TRIGGER product_stock_count_ins
  AFTER INSERT ON public.product_stock
  REFERENCING NEW TABLE AS new_stock
  FOR EACH STATEMENT EXECUTE FUNCTION public.sync_stock_count_ins();

CREATE TRIGGER product_stock_count_del
  AFTER DELETE ON public.product_stock
  REFERENCING OLD TABLE AS old_stock
  FOR EACH STATEMENT EXECUTE FUNCTION public.sync_stock_count_del();

-- The old per-row function is no longer referenced by any trigger. Drop it so
-- it can't be re-attached by mistake. (CASCADE not needed; no dependents.)
DROP FUNCTION IF EXISTS public.sync_stock_count();
