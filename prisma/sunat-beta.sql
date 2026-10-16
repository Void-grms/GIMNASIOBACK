CREATE TABLE IF NOT EXISTS "public"."SunatConfig" (
 "id" TEXT NOT NULL DEFAULT 'beta', "datos" TEXT NOT NULL DEFAULT '{}', "secretos" TEXT,
 "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SunatConfig_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE TABLE IF NOT EXISTS "public"."SunatSeriePrueba" (
 "id" TEXT NOT NULL, "ruc" TEXT NOT NULL, "tipo" TEXT NOT NULL, "numero" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "SunatSeriePrueba_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "SunatSeriePrueba_ruc_tipo_key" ON "public"."SunatSeriePrueba"("ruc", "tipo");
-- statement-break
CREATE TABLE IF NOT EXISTS "public"."SunatPrueba" (
 "id" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "entorno" TEXT NOT NULL DEFAULT 'beta',
 "ruc" TEXT NOT NULL, "tipo" TEXT NOT NULL, "serie" TEXT NOT NULL, "numero" INTEGER NOT NULL,
 "snapshot" TEXT NOT NULL, "estado" TEXT NOT NULL DEFAULT 'creado', "intentos" INTEGER NOT NULL DEFAULT 0,
 "codigo" TEXT, "mensaje" TEXT, "ticket" TEXT, "hash" TEXT, "xmlCifrado" TEXT, "cdrCifrado" TEXT,
 "leaseId" TEXT, "leaseUntil" TIMESTAMP(3), "emitidoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "actualizadoAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SunatPrueba_pkey" PRIMARY KEY ("id")
);
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "SunatPrueba_idempotencyKey_key" ON "public"."SunatPrueba"("idempotencyKey");
-- statement-break
CREATE UNIQUE INDEX IF NOT EXISTS "SunatPrueba_ruc_tipo_serie_numero_key" ON "public"."SunatPrueba"("ruc", "tipo", "serie", "numero");
-- statement-break
CREATE INDEX IF NOT EXISTS "SunatPrueba_estado_leaseUntil_idx" ON "public"."SunatPrueba"("estado", "leaseUntil");
