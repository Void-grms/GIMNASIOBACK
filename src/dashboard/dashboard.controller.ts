import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { SoloStaffGuard } from '../auth/solo-staff.guard';

@Controller('dashboard')
@UseGuards(SoloStaffGuard)
export class DashboardController {
  constructor(private dashboard: DashboardService) {}

  @Get('stats')
  resumen() {
    return this.dashboard.resumen();
  }

  @Get('at-risk')
  enRiesgo() {
    return this.dashboard.enRiesgo();
  }

  @Get('cohorts')
  cohortes() {
    return this.dashboard.cohortes();
  }

  @Get('occupancy')
  ocupacion() {
    return this.dashboard.ocupacion();
  }
}
