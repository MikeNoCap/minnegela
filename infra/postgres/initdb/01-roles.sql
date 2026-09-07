-- Runs once on first container start (docker-entrypoint-initdb.d).
-- Two application roles: the API is subject to RLS, workers bypass it.
-- Passwords are the POSTGRES_PASSWORD in dev; rotate in production via ALTER ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minnegela_api') THEN
    CREATE ROLE minnegela_api LOGIN PASSWORD 'minnegela';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minnegela_worker') THEN
    CREATE ROLE minnegela_worker LOGIN PASSWORD 'minnegela' BYPASSRLS;
  END IF;
END $$;
GRANT CONNECT ON DATABASE minnegela TO minnegela_api, minnegela_worker;
