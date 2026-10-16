import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PrismaService } from '../prisma/prisma.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { Publico } from '../auth/publico.decorator';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';
import { esPostgres } from '../common/archivos';
import { congelarPlan } from './condiciones';
import { MS_DIA } from '../common/fechas';

const textoLimpio = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CrearPlanDto {
  @Transform(textoLimpio) @IsString() @MinLength(2) @MaxLength(100) nombre: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) precio: number;
  @IsInt() @Min(1) @Max(3660) duracionDias: number;
  @IsOptional() @IsInt() @Min(1) @Max(3660) limiteAsistencias?: number | null;
  @IsOptional() @IsBoolean() esPromocion?: boolean;
  @IsOptional() @IsBoolean() requiereEvidencia?: boolean;
  @Transform(textoLimpio) @IsOptional() @IsString() @MaxLength(1000) descripcion?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) orden?: number;
}

export class EditarPlanDto {
  @Transform(textoLimpio) @IsOptional() @IsString() @MinLength(2) @MaxLength(100) nombre?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) precio?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3660) duracionDias?: number;
  @IsOptional() @IsInt() @Min(1) @Max(3660) limiteAsistencias?: number | null;
  @IsOptional() @IsBoolean() esPromocion?: boolean;
  @IsOptional() @IsBoolean() requiereEvidencia?: boolean;
  @Transform(textoLimpio) @IsOptional() @IsString() @MaxLength(1000) descripcion?: string;
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) orden?: number;
}

@Controller('plans')
export class PlansController {
  constructor(private prisma: PrismaService) {}

  @Publico()
  @Get('public')
  publico() {
    return this.prisma.plan.findMany({
      where: { activo: true }, orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
      select: { id: true, nombre: true, precio: true, duracionDias: true, limiteAsistencias: true,
        esPromocion: true, descripcion: true, requiereEvidencia: true, orden: true },
    });
  }

  @UseGuards(SoloStaffGuard)
  @Get()
  listar() {
    return this.prisma.plan.findMany({ where: { activo: true }, orderBy: [{ orden: 'asc' }, { nombre: 'asc' }] });
  }

  @UseGuards(SoloStaffGuard)
  @Get('admin')
  async administrar(@SesionActual() sesion: Sesion, @Query('estado') estado = 'activos', @Query('q') q = '') {
    this.exigirAdmin(sesion);
    if (!['activos', 'inactivos', 'todos'].includes(estado)) throw new BadRequestException('Filtro de planes invalido');
    if (typeof q !== 'string' || q.length > 100) throw new BadRequestException('La busqueda admite hasta 100 caracteres');
    const texto = q.trim();
    const planes = await this.prisma.plan.findMany({
      where: { ...(estado === 'todos' ? {} : { activo: estado === 'activos' }),
        ...(texto ? { nombre: { contains: texto, ...(esPostgres() ? { mode: 'insensitive' } : {}) } as any } : {}) },
      orderBy: [{ activo: 'desc' }, { orden: 'asc' }, { nombre: 'asc' }],
    });
    return planes.map(p => ({ ...p, historico: p.id.startsWith('erp_') }));
  }

  @UseGuards(SoloStaffGuard)
  @Post()
  crear(@Body() dto: CrearPlanDto, @SesionActual() sesion: Sesion) {
    this.exigirAdmin(sesion);
    this.validarNoNulos(dto);
    return this.prisma.plan.create({ data: { ...dto, nombre: dto.nombre.trim(), descripcion: dto.descripcion?.trim() || null } });
  }

  @UseGuards(SoloStaffGuard)
  @Patch(':id')
  async editar(@Param('id') id: string, @Body() dto: EditarPlanDto, @SesionActual() sesion: Sesion) {
    this.exigirAdmin(sesion);
    this.validarNoNulos(dto);
    if (id.startsWith('erp_')) throw new BadRequestException('Este plan conserva contratos importados. Crea una copia para ofrecerlo de nuevo.');
    return this.prisma.$transaction(async tx => {
      const tomada = await tx.plan.updateMany({ where: { id }, data: { orden: { increment: 0 } } });
      if (!tomada.count) throw new NotFoundException('Plan no encontrado');
      const anterior = await tx.plan.findUnique({ where: { id } });
      // Contratos anteriores al cambio: congelar lo que ya tenian, sin tocar importaciones ni imponerles cupos.
      const legados = await tx.membership.findMany({ where: { planId: id, codigoERP: null, planNombre: null } });
      for (const m of legados) {
        await tx.membership.update({ where: { id: m.id }, data: { ...congelarPlan(anterior),
          duracionDiasContratada: Math.max(1, Math.round((m.fechaFin.getTime() - m.fechaInicio.getTime()) / MS_DIA) + 1), limiteAsistencias: null } });
      }
      await tx.renewalRequest.updateMany({ where: { planId: id, planNombre: null },
        data: { ...congelarPlan(anterior), limiteAsistencias: null } });
      return tx.plan.update({ where: { id }, data: { ...dto,
        ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
        ...(dto.descripcion !== undefined ? { descripcion: dto.descripcion.trim() || null } : {}) } });
    }, { maxWait: 10000, timeout: 10000 });
  }

  private exigirAdmin(sesion: Sesion) {
    if (sesion?.tipo !== 'staff' || sesion.rol !== 'admin') throw new ForbiddenException('Solo el administrador puede gestionar los planes');
  }

  private validarNoNulos(dto: object) {
    if (Object.entries(dto).some(([campo, valor]) => valor === null && campo !== 'limiteAsistencias')) {
      throw new BadRequestException('Completa los datos del plan; solo el limite de asistencias puede quedar sin limite');
    }
  }
}
