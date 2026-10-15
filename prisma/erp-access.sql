-- Cambios aditivos del acceso ERP; conservar todos los datos existentes.
-- statement-break
ALTER TABLE "public"."User"
  ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
-- statement-break
CREATE TABLE IF NOT EXISTS "public"."RateLimitBucket" (
  "key" TEXT NOT NULL,
  "hits" INTEGER NOT NULL DEFAULT 1,
  "resetAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);
-- statement-break
CREATE INDEX IF NOT EXISTS "RateLimitBucket_resetAt_idx" ON "public"."RateLimitBucket"("resetAt");
-- statement-break
CREATE INDEX IF NOT EXISTS "Payment_memberId_fecha_idx" ON "public"."Payment"("memberId", "fecha");
-- statement-break
CREATE INDEX IF NOT EXISTS "PreCheckIn_memberId_estado_expiresAt_idx" ON "public"."PreCheckIn"("memberId", "estado", "expiresAt");
-- statement-break
CREATE INDEX IF NOT EXISTS "OrderItem_orderId_idx" ON "public"."OrderItem"("orderId");
-- statement-break
CREATE INDEX IF NOT EXISTS "OrderItem_productId_orderId_idx" ON "public"."OrderItem"("productId", "orderId");
-- statement-break
ALTER TABLE "public"."Member"
  ADD COLUMN IF NOT EXISTS "codigoERP" TEXT,
  ADD COLUMN IF NOT EXISTS "documentoERP" TEXT,
  ADD COLUMN IF NOT EXISTS "pinTemporalHasta" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "portalVersion" INTEGER NOT NULL DEFAULT 0,
  ALTER COLUMN "dni" DROP NOT NULL;
-- statement-break
ALTER TABLE "public"."Membership"
  ADD COLUMN IF NOT EXISTS "codigoERP" TEXT,
  ADD COLUMN IF NOT EXISTS "estadoERP" TEXT;
-- statement-break
CREATE TABLE IF NOT EXISTS "public"."PortalActivation" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortalActivation_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "PortalActivation_tokenHash_key" ON "public"."PortalActivation"("tokenHash");
-- statement-break
CREATE INDEX IF NOT EXISTS "PortalActivation_memberId_usedAt_idx" ON "public"."PortalActivation"("memberId", "usedAt");
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "Member_codigoERP_key" ON "public"."Member"("codigoERP");
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_codigoERP_key" ON "public"."Membership"("codigoERP");
-- statement-break
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PortalActivation_memberId_fkey'
      AND conrelid = 'public."PortalActivation"'::regclass
  ) THEN
    ALTER TABLE "public"."PortalActivation"
      ADD CONSTRAINT "PortalActivation_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "public"."Member"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$migration$;
