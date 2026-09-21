import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { Publico } from '../auth/publico.decorator';

/** Recepcion: armar el mensaje de WhatsApp del cobro y dejar constancia del envio. */
@Controller('payments')
@UseGuards(SoloStaffGuard)
export class MessagesController {
  constructor(private messages: MessagesService) {}

  /** `origen` es la direccion del panel: con ella se arman los enlaces del mensaje. */
  @Get(':id/whatsapp')
  whatsapp(@Param('id') id: string, @Query('origen') origen: string) {
    return this.messages.paraWhatsapp(id, origen);
  }

  @Post(':id/whatsapp/enviado')
  enviado(@Param('id') id: string, @Body('mensaje') mensaje: string) {
    return this.messages.registrarEnvio(id, typeof mensaje === 'string' ? mensaje : '');
  }
}

/** El link que recibe el socio. Sin firma valida responde 404. */
@Controller('public')
export class PublicReceiptController {
  constructor(private messages: MessagesService) {}

  @Publico()
  @Get('pago/:id')
  pago(@Param('id') id: string, @Query('t') t?: string) {
    return this.messages.publico(id, t);
  }
}
