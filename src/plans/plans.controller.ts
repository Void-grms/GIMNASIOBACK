import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';

class CrearPlanDto {
  @IsString() @MinLength(2) nombre: string;
  @IsNumber() @Min(0) precio: number;
  @IsInt() @Min(1) duracionDias: number;
  @IsOptional() @IsBoolean() requiereEvidencia?: boolean;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() @IsInt() orden?: number;
}

class EditarPlanDto {
  @IsOptional() @IsString() nombre?: string;
  @IsOptional() @IsNumber() @Min(0) precio?: number;
  @IsOptional() @IsInt() @Min(1) duracionDias?: number;
  @IsOptional() @IsBoolean() requiereEvidencia?: boolean;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsOptional() @IsInt() orden?: number;
}

@Controller('plans')
@UseGuards(SoloStaffGuard)
export class PlansController {
  constructor(private prisma: PrismaService) {}

  @Get()
  listar() {
    return this.prisma.plan.findMany({ where: { activo: true }, orderBy: { orden: 'asc' } });
  }

  @Post()
  crear(@Body() dto: CrearPlanDto) {
    return this.prisma.plan.create({ data: dto });
  }

  @Patch(':id')
  editar(@Param('id') id: string, @Body() dto: EditarPlanDto) {
    return this.prisma.plan.update({ where: { id }, data: dto });
  }
}
