-- Owner/admin roles now come only from the OWNER_EMAILS env variable: the
-- server grants or removes them on login (src/lib/cloud-access.server.ts).
-- Redefine the signup trigger function without any hardcoded owner email.
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
  RETURN NEW;
END $$;
