import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { QrModule } from './qr/qr.module';
import { AuthModule } from './auth/auth.module';
import { MembersModule } from './members/members.module';
import { PlansModule } from './plans/plans.module';
import { MembershipsModule } from './memberships/memberships.module';
import { CheckinsModule } from './checkins/checkins.module';
import { PortalModule } from './portal/portal.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { CashModule } from './cash/cash.module';
import { ProductsModule } from './products/products.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SettingsModule } from './settings/settings.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { ComplaintsModule } from './complaints/complaints.module';
import { SystemModule } from './system/system.module';
import { GuestsModule } from './guests/guests.module';
import { TrainingModule } from './training/training.module';
import { RenewalsModule } from './renewals/renewals.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    QrModule,
    SettingsModule,
    ReceiptsModule,
    AuthModule,
    MembersModule,
    PlansModule,
    MembershipsModule,
    CheckinsModule,
    PortalModule,
    DashboardModule,
    CashModule,
    ProductsModule,
    NotificationsModule,
    ComplaintsModule,
    SystemModule,
    GuestsModule,
    TrainingModule,
    RenewalsModule,
  ],
})
export class AppModule {}
