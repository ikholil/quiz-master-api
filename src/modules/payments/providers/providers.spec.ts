import { createHash } from 'node:crypto';
import { hmacSha256 } from '../../../common/utils/crypto.util';
import { InvalidWebhookError } from './payment-provider';
import { SandboxPaymentProvider } from './sandbox.provider';
import { SslCommerzProvider } from './sslcommerz.provider';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('SandboxPaymentProvider webhook verification', () => {
  const store = new Map<string, string>();
  const redis = {
    set: jest.fn(async (k: string, v: string) => store.set(k, v)),
    get: jest.fn(async (k: string) => store.get(k) ?? null),
  };
  const provider = new SandboxPaymentProvider('secret', redis as never, 'http://localhost');
  const body = { eventId: 'e1', merchantTxnId: 'QM1', status: 'SUCCEEDED', amountMinor: 29900 };
  const raw = Buffer.from(JSON.stringify(body));

  it('rejects a missing or forged signature', async () => {
    await expect(provider.parseWebhook({}, raw, body)).rejects.toBeInstanceOf(InvalidWebhookError);
    await expect(
      provider.parseWebhook({ 'x-sandbox-signature': hmacSha256('wrong', raw) }, raw, body),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
  });

  it('rejects a body tampered after signing', async () => {
    const sig = hmacSha256('secret', raw);
    const tampered = Buffer.from(JSON.stringify({ ...body, amountMinor: 1 }));
    await expect(
      provider.parseWebhook({ 'x-sandbox-signature': sig }, tampered, { ...body, amountMinor: 1 }),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
  });

  it('accepts a valid signature and the verify call then reports the signed status', async () => {
    const ev = await provider.parseWebhook({ 'x-sandbox-signature': hmacSha256('secret', raw) }, raw, body);
    expect(ev).toMatchObject({ eventId: 'e1', merchantTxnId: 'QM1' });
    await expect(provider.verify({ merchantTxnId: 'QM1' } as never)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      amountMinor: 29900,
    });
  });
});

describe('SslCommerzProvider IPN signature', () => {
  const provider = new SslCommerzProvider('store', 'pass123', true);
  const fields: Record<string, string> = { tran_id: 'QM1', val_id: 'V1', amount: '299.00', status: 'VALID' };
  const keys = 'tran_id,val_id,amount,status';
  const sign = md5(
    [...keys.split(','), 'store_passwd']
      .sort()
      .map((k) => `${k}=${k === 'store_passwd' ? md5('pass123') : fields[k]}`)
      .join('&'),
  );

  it('accepts a correctly signed IPN', async () => {
    await expect(
      provider.parseWebhook({}, Buffer.alloc(0), { ...fields, verify_key: keys, verify_sign: sign }),
    ).resolves.toMatchObject({ eventId: 'V1', merchantTxnId: 'QM1' });
  });

  it('rejects a modified amount', async () => {
    await expect(
      provider.parseWebhook({}, Buffer.alloc(0), {
        ...fields,
        amount: '1.00',
        verify_key: keys,
        verify_sign: sign,
      }),
    ).rejects.toBeInstanceOf(InvalidWebhookError);
  });
});
