import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { GuestsService } from './guests.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { EsCelular, EsDni } from '../common/validadores';

class InvitadoDto {
  @IsString() memberId: string;
  @IsString() @MinLength(3, { message: 'Escribe el nombre del invitado' }) @MaxLength(120) nombre: string;
  @EsDni() dni: string;
  @IsOptional() @EsCelular() telefono?: string;
  @IsOptional() @IsString() @MaxLength(200) nota?: string;
}

@Controller('guests')
@UseGuards(SoloStaffGuard)
export class GuestsController {
  constructor(private guests: GuestsService) {}

  @Get()
  listar(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.guests.listar(desde, hasta);
  }

  @Get('quota/:memberId')
  cupo(@Param('memberId') memberId: string) {
    return this.guests.cupo(memberId);
  }

  @Post()
  registrar(@Body() dto: InvitadoDto) {
    return this.guests.registrar(dto);
  }
}
