import { Injectable, OnModuleInit, OnApplicationShutdown, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { databaseUrl } from '../common/database-url';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(@Optional() options?: Prisma.PrismaClientOptions) {
    const url = databaseUrl();
    super(options || (url ? { datasources: { db: { url } } } : undefined));
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
