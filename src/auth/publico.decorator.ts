import { SetMetadata } from '@nestjs/common';
export const PUBLICO = 'publico';
export const Publico = () => SetMetadata(PUBLICO, true);
