-- Cambios aditivos: ningun contrato historico recibe una deuda nueva.
-- statement-break
ALTER TABLE "public"."Membership"
  ADD COLUMN IF NOT EXISTS "totalContratadoCentimos" INTEGER,
  ADD COLUMN IF NOT EXISTS "fechaLimiteSaldo" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "versionCuenta" INTEGER NOT NULL DEFAULT 0;
-- statement-break
ALTER TABLE "public"."Payment" ADD COLUMN IF NOT EXISTS "montoCentimos" INTEGER;
-- statement-break
CREATE TABLE IF NOT EXISTS "public"."MembershipFreeze" (
  "id" TEXT NOT NULL, "membershipId" TEXT NOT NULL, "operationId" TEXT NOT NULL,
  "desde" TIMESTAMP(3) NOT NULL, "hasta" TIMESTAMP(3) NOT NULL, "dias" INTEGER NOT NULL,
  "motivo" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipFreeze_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipFreeze_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "public"."Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "MembershipFreeze_operationId_key" ON "public"."MembershipFreeze"("operationId");
-- statement-break
CREATE INDEX IF NOT EXISTS "MembershipFreeze_membershipId_desde_hasta_idx" ON "public"."MembershipFreeze"("membershipId", "desde", "hasta");
-- statement-break
CREATE TABLE IF NOT EXISTS "public"."MembershipOperation" (
  "id" TEXT NOT NULL, "tipo" TEXT NOT NULL, "huella" TEXT NOT NULL,
  "memberId" TEXT NOT NULL, "membershipId" TEXT NOT NULL, "paymentId" TEXT,
  "usuarioId" TEXT NOT NULL, "usuarioNombre" TEXT NOT NULL, "rol" TEXT NOT NULL,
  "motivo" TEXT, "aprobado" BOOLEAN NOT NULL DEFAULT false, "datos" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipOperation_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "public"."Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "MembershipOperation_paymentId_key" ON "public"."MembershipOperation"("paymentId");
-- statement-break
CREATE INDEX IF NOT EXISTS "MembershipOperation_membershipId_createdAt_idx" ON "public"."MembershipOperation"("membershipId", "createdAt");
-- statement-break
CREATE INDEX IF NOT EXISTS "MembershipOperation_memberId_createdAt_idx" ON "public"."MembershipOperation"("memberId", "createdAt");
