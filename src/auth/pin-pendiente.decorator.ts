import { SetMetadata } from '@nestjs/common';

export const PERMITE_PIN_PENDIENTE = 'permite_pin_pendiente';
/** Solo el perfil minimo y el cambio de PIN pueden usar la sesion temporal. */
export const PermitePinPendiente = () => SetMetadata(PERMITE_PIN_PENDIENTE, true);
