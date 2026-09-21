import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { OrdersService } from './orders.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class ItemPedidoDto {
  @IsString() productId: string;
  @IsInt({ message: 'La cantidad debe ser un numero entero' })
  @Min(1, { message: 'La cantidad minima es 1' })
  @Max(10, { message: 'Maximo 10 unidades por producto' })
  cantidad: number;
}

class CrearPedidoDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'El pedido esta vacio' })
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => ItemPedidoDto)
  items: ItemPedidoDto[];

  @IsOptional() @IsString() @MaxLength(140) nota?: string;
}

class EntregarDto {
  @IsIn(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'], {
    message: 'Metodo de pago invalido',
  })
  metodo: string;
}

/** Lado del socio: la tienda del portal. */
@Controller('portal')
export class PortalOrdersController {
  constructor(private orders: OrdersService) {}

  private soloSocio(sesion: Sesion) {
    if (!sesion || sesion.tipo !== 'socio') {
      throw new ForbiddenException('Este endpoint es del portal del socio');
    }
    return sesion.sub;
  }

  @Get('store')
  tienda(@SesionActual() sesion: Sesion) {
    this.soloSocio(sesion);
    return this.orders.tienda();
  }

  @Get('orders')
  misPedidos(@SesionActual() sesion: Sesion) {
    return this.orders.misPedidos(this.soloSocio(sesion));
  }

  @Post('orders')
  pedir(@SesionActual() sesion: Sesion, @Body() dto: CrearPedidoDto) {
    return this.orders.crear(this.soloSocio(sesion), dto);
  }

  @Post('orders/:id/cancel')
  cancelar(@SesionActual() sesion: Sesion, @Param('id') id: string) {
    return this.orders.cancelarDelSocio(this.soloSocio(sesion), id);
  }
}

/** Lado de recepcion: cobrar y entregar lo que pidieron. */
@Controller('orders')
@UseGuards(SoloStaffGuard)
export class OrdersController {
  constructor(private orders: OrdersService) {}

  @Get()
  pendientes() {
    return this.orders.pendientes();
  }

  @Post(':id/deliver')
  entregar(@Param('id') id: string, @Body() dto: EntregarDto, @SesionActual() sesion: Sesion) {
    return this.orders.entregar(id, dto.metodo, sesion.sub);
  }

  @Post(':id/cancel')
  cancelar(@Param('id') id: string, @SesionActual() sesion: Sesion) {
    return this.orders.cancelarEnRecepcion(id, sesion.sub);
  }
}
