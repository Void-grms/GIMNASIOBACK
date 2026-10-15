import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LoginRateService {
  constructor(private prisma: PrismaService) {}

  /** Un unico UPSERT atomico: el limite se comparte entre todas las replicas. */
  async tomar(identificador: string, limit: number, ttl: number) {
    const key = createHash('sha256').update(identificador).digest('hex');
    const now = new Date();
    const until = new Date(now.getTime() + ttl);
    const [bucket] = await this.prisma.$queryRaw<{ hits: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitBucket" ("key", "hits", "resetAt") VALUES (${key}, 1, ${until})
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN 1
          WHEN "RateLimitBucket"."hits" < 1000000 THEN "RateLimitBucket"."hits" + 1 ELSE 1000000 END,
        "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN ${until}
          ELSE "RateLimitBucket"."resetAt" END
      RETURNING "hits", "resetAt"`;
    return {
      permitido: bucket.hits <= limit,
      restantes: Math.max(0, limit - bucket.hits),
      reintentarEn: Math.max(1, Math.ceil((new Date(bucket.resetAt).getTime() - now.getTime()) / 1000)),
    };
  }

  @Cron('17 */10 * * * *')
  async limpiar() {
    // Ventanas vencidas hace mas de un dia; varias instancias pueden limpiar.
    await this.prisma.rateLimitBucket.deleteMany({
      where: { resetAt: { lt: new Date(Date.now() - 86400000) } },
    });
  }
}
