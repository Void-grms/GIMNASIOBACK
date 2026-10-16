-- Cambio aditivo: sin actualizaciones de contratos ni catalogos importados.
-- statement-break
ALTER TABLE "public"."Plan"
  ADD COLUMN IF NOT EXISTS "limiteAsistencias" INTEGER,
  ADD COLUMN IF NOT EXISTS "esPromocion" BOOLEAN NOT NULL DEFAULT false;
-- statement-break
ALTER TABLE "public"."Membership"
  ADD COLUMN IF NOT EXISTS "planNombre" TEXT,
  ADD COLUMN IF NOT EXISTS "planDescripcion" TEXT,
  ADD COLUMN IF NOT EXISTS "duracionDiasContratada" INTEGER,
  ADD COLUMN IF NOT EXISTS "requiereEvidenciaContratada" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "limiteAsistencias" INTEGER,
  ADD COLUMN IF NOT EXISTS "asistenciasUsadas" INTEGER NOT NULL DEFAULT 0;
-- statement-break
ALTER TABLE "public"."RenewalRequest"
  ADD COLUMN IF NOT EXISTS "planNombre" TEXT,
  ADD COLUMN IF NOT EXISTS "planDescripcion" TEXT,
  ADD COLUMN IF NOT EXISTS "duracionDiasContratada" INTEGER,
  ADD COLUMN IF NOT EXISTS "requiereEvidenciaContratada" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "limiteAsistencias" INTEGER;
-- statement-break
CREATE INDEX IF NOT EXISTS "CheckIn_membershipId_resultado_tipo_timestamp_idx"
  ON "public"."CheckIn"("membershipId", "resultado", "tipo", "timestamp");
