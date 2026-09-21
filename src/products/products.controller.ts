import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString,
  Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { EsMonto } from '../common/validadores';
import { ProductsService } from './products.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';
import { SesionActual } from '../auth/sesion.decorator';
import type { Sesion } from '../auth/jwt.guard';

class CrearProductoDto {
  @IsString() @MinLength(2, { message: 'El nombre es muy corto' }) @MaxLength(80) nombre: string;
  @IsNumber() @Min(0) @EsMonto() precio: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) stock?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) stockMinimo?: number;
  @IsOptional() @IsBoolean() esServicio?: boolean;
}

class EditarProductoDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) nombre?: string;
  @IsOptional() @IsNumber() @Min(0) @EsMonto() precio?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) stockMinimo?: number;
  @IsOptional() @IsBoolean() activo?: boolean;
}

class ItemVentaDto {
  @IsString() productId: string;
  @IsInt({ message: 'La cantidad debe ser un numero entero' })
  @Min(1, { message: 'La cantidad minima es 1' })
  @Max(500)
  cantidad: number;
}

class ComprobanteDto {
  @IsIn(['boleta', 'factura', 'recibo']) tipo: string;
  @IsIn(['dni', 'ruc', 'ce', 'pasaporte', 'sin_documento']) clienteTipoDoc: string;
  @IsOptional() @IsString() @MaxLength(15) clienteNumDoc?: string;
  @IsOptional() @IsString() @MaxLength(150) clienteNombre?: string;
  @IsOptional() @IsString() @MaxLength(200) clienteDireccion?: string;
}

class VenderDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'La venta no tiene productos' })
  @ValidateNested({ each: true })
  @Type(() => ItemVentaDto)
  items: ItemVentaDto[];

  @IsIn(['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'], {
    message: 'Metodo de pago invalido',
  })
  metodo: string;

  @IsOptional() @IsString() memberId?: string;
  @IsOptional() @IsString() @MaxLength(300) nota?: string;

  @IsOptional() @IsObject() @ValidateNested() @Type(() => ComprobanteDto)
  comprobante?: ComprobanteDto;
}

@Controller()
@UseGuards(SoloStaffGuard)
export class ProductsController {
  constructor(private products: ProductsService) {}

  @Get('products')
  listar(@Query('todos') todos?: string) {
    return this.products.listar(todos === '1');
  }

  @Get('products/low-stock')
  bajoStock() {
    return this.products.bajoStock();
  }

  @Post('products')
  crear(@Body() dto: CrearProductoDto) {
    return this.products.crear(dto);
  }

  @Patch('products/:id')
  editar(@Param('id') id: string, @Body() dto: EditarProductoDto) {
    return this.products.editar(id, dto);
  }

  @Post('products/:id/stock')
  stock(@Param('id') id: string, @Body('cantidad') cantidad: number) {
    const n = Number(cantidad);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 10000) {
      throw new BadRequestException('El ajuste de stock debe ser un entero distinto de cero');
    }
    return this.products.ajustarStock(id, n);
  }

  @Post('sales')
  vender(@Body() dto: VenderDto, @SesionActual() sesion: Sesion) {
    return this.products.vender({ ...dto, cajeroId: sesion.sub });
  }

  @Get('sales')
  ventas(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.products.ventas(desde, hasta);
  }
}
