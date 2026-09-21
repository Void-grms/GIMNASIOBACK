import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { OrdersService } from './orders.service';
import { LockersService } from './lockers.service';
import { OrdersController, PortalOrdersController } from './orders.controller';

@Module({
  providers: [ProductsService, OrdersService, LockersService],
  controllers: [ProductsController, OrdersController, PortalOrdersController],
})
export class ProductsModule {}
