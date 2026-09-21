import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';

@Controller('notifications')
@UseGuards(SoloStaffGuard)
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get('pending')
  pendientes() {
    return this.notifications.pendientes();
  }

  @Get('history')
  historial() {
    return this.notifications.historial();
  }

  @Post(':memberId/sent')
  marcar(
    @Param('memberId') memberId: string,
    @Body('tipo') tipo: string,
    @Body('mensaje') mensaje: string,
  ) {
    return this.notifications.marcarEnviado(memberId, tipo || 'por_vencer', mensaje || '');
  }
}
