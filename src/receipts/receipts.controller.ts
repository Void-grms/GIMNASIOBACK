import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { ReceiptsService } from './receipts.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';

class AnularDto {
  @IsString() @MinLength(5, { message: 'Explica el motivo de la anulacion' }) motivo: string;
}

@Controller('receipts')
@UseGuards(SoloStaffGuard)
export class ReceiptsController {
  constructor(private receipts: ReceiptsService) {}

  @Get()
  listar(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('tipo') tipo?: string,
  ) {
    return this.receipts.listar({ desde, hasta, tipo });
  }

  @Get('pending')
  async pendientes() {
    const lista = await this.receipts.pendientes();
    return { total: lista.length, comprobantes: lista };
  }

  @Post('retry-pending')
  reintentar() {
    return this.receipts.reintentarPendientes();
  }

  @Get(':id')
  obtener(@Param('id') id: string) {
    return this.receipts.obtener(id);
  }

  @Post(':id/anular')
  anular(@Param('id') id: string, @Body() dto: AnularDto) {
    return this.receipts.anular(id, dto.motivo);
  }
}
