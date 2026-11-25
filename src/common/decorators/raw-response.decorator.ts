import { SetMetadata } from '@nestjs/common';
import { RAW_RESPONSE_KEY } from '../interceptors/response-envelope.interceptor';

/** Skip the response envelope (payment provider callbacks, health probes that must return plain bodies). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
