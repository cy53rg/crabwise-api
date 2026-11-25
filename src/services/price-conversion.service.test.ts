import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock, envMock, redisMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  envMock: {
    stellarNetwork: 'testnet' as 'testnet' | 'public',
    databaseUrl: 'postgresql://u:p@localhost:5432/db',
    databasePoolSize: 20,
    priceAssetIssuers: {
      USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      EURC: undefined as string | undefined,
      NGNT: undefined as string | undefined,
    },
  },
  redisMock: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('@/config', () => ({ env: envMock }));
vi.mock('@/utils', () => ({ logger: loggerMock }));
vi.mock('./redis.service', () => ({ tryGetRedisClient: () => redisMock }));

import {
  ASSET_PRECISION,
  CONVERSION_ROUNDING_MODE,
  convertAmount,
  getPriceConversionMetrics,
  getRate,
  tryConvertAmount,
} from './price-conversion.service';

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  envMock.stellarNetwork = 'testnet';
  envMock.priceAssetIssuers.NGNT = undefined;
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue('OK');
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('price conversion observability (#871)', () => {
  it('logs a warn and counts a network error when Horizon is unreachable', async () => {
    const before = getPriceConversionMetrics().networkErrors;
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    expect(rate).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'price-conversion: could not reach Horizon',
      expect.objectContaining({ pair: 'XLM/USDC', message: 'ECONNREFUSED' }),
    );
    expect(getPriceConversionMetrics().networkErrors).toBe(before + 1);
  });

  it('logs a warn with status details on a non-2xx Horizon response', async () => {
    const before = getPriceConversionMetrics().httpErrors;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    expect(rate).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'price-conversion: Horizon returned an error',
      expect.objectContaining({ status: 429, pair: 'XLM/USDC' }),
    );
    expect(getPriceConversionMetrics().httpErrors).toBe(before + 1);
  });

  it('logs an error (not a warn) when an asset issuer is missing — config, not outage', async () => {
    const before = getPriceConversionMetrics().configErrors;
    global.fetch = vi.fn() as unknown as typeof fetch;

    const rate = await getRate('NGNT', 'XLM');

    expect(rate).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'price-conversion: asset issuer not configured',
      expect.objectContaining({ pair: 'NGNT/XLM' }),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(getPriceConversionMetrics().configErrors).toBe(before + 1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('logs debug and counts an empty order book separately from failures', async () => {
    const before = getPriceConversionMetrics().emptyOrderBooks;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [], asks: [] }),
    }) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    expect(rate).toBeNull();
    expect(loggerMock.debug).toHaveBeenCalledWith('price-conversion: order book is empty', {
      pair: 'XLM/USDC',
    });
    expect(getPriceConversionMetrics().emptyOrderBooks).toBe(before + 1);
  });

  it('counts successes and keeps the public getRate contract unchanged', async () => {
    const before = getPriceConversionMetrics().successes;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [{ price: '0.10' }], asks: [{ price: '0.12' }] }),
    }) as unknown as typeof fetch;

    const rate = await getRate('XLM', 'USDC');

    // Public API is unchanged: a plain number (or null) — no Result type.
    expect(rate).toBeCloseTo(0.11);
    expect(getPriceConversionMetrics().successes).toBe(before + 1);
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('convertAmount still surfaces a 422 when no rate is available', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;

    await expect(convertAmount(10, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    });
  });
});

describe('preserve decimal precision in price conversion (#62)', () => {
  it('preserves precision for fractional amounts without floating-point artifacts', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [{ price: '0.2' }], asks: [{ price: '0.2' }] }),
    }) as unknown as typeof fetch;

    const result = await convertAmount(0.1, 'XLM', 'USDC');
    expect(result.amount).toBe(0.02);
    expect(result.rate).toBe(0.2);
  });

  it('preserves fractional precision for high-precision target asset (XLM 7 decimals)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [{ price: '1.5' }], asks: [{ price: '1.5' }] }),
    }) as unknown as typeof fetch;

    const result = await convertAmount(0.0000002, 'USDC', 'XLM');
    expect(result.amount).toBe(0.0000003);
  });

  it('preserves precision for large amounts without precision loss', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [{ price: '1.25' }], asks: [{ price: '1.25' }] }),
    }) as unknown as typeof fetch;

    const largeAmount = 100_000_000.5;
    const result = await convertAmount(largeAmount, 'XLM', 'USDC');
    expect(result.amount).toBe(125000000.63);
  });

  it('preserves precision when tryConvertAmount is used with fractional and large amounts', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [{ price: '0.07' }], asks: [{ price: '0.07' }] }),
    }) as unknown as typeof fetch;

    const fractional = await tryConvertAmount(0.1, 'XLM', 'USDC');
    expect(fractional).not.toBeNull();
    expect(fractional?.amount).toBe(0.01);

    const large = await tryConvertAmount(1_000_000_000, 'XLM', 'USDC');
    expect(large).not.toBeNull();
    expect(large?.amount).toBe(70000000);
  });
});

describe('handle missing exchange-rate data (#63)', () => {
  it('surfaces unavailable rate explicitly with UNPROCESSABLE_ENTITY and does not fabricate a price in convertAmount', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [], asks: [] }),
    }) as unknown as typeof fetch;

    await expect(convertAmount(100, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      message: 'No exchange rate is currently available for XLM -> USDC.',
    });
  });

  it('avoids fabricating a converted price and returns null in tryConvertAmount when order book is empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ bids: [], asks: [] }),
    }) as unknown as typeof fetch;

    const result = await tryConvertAmount(100, 'XLM', 'USDC');
    expect(result).toBeNull();
  });

  it('surfaces unavailable rate when Horizon network call fails, avoiding fallback fabrication', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network offline')) as unknown as typeof fetch;

    await expect(convertAmount(50, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
    });
    const result = await tryConvertAmount(50, 'XLM', 'USDC');
    expect(result).toBeNull();
  });

  it('surfaces unavailable rate when asset issuer is not configured, avoiding fabricated rate', async () => {
    envMock.priceAssetIssuers.NGNT = undefined;

    await expect(convertAmount(50, 'NGNT', 'USDC')).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      message: 'No exchange rate is currently available for NGNT -> USDC.',
    });
    const result = await tryConvertAmount(50, 'NGNT', 'USDC');
    expect(result).toBeNull();
  });
});

describe('conversion rounding rules (#64)', () => {
  it('specifies expected currency precision for all supported assets', () => {
    expect(ASSET_PRECISION.XLM).toBe(7);
    expect(ASSET_PRECISION.USDC).toBe(2);
    expect(ASSET_PRECISION.EURC).toBe(2);
    expect(ASSET_PRECISION.NGNT).toBe(2);
    expect(CONVERSION_ROUNDING_MODE).toBeDefined();
  });

  it('rounds half up at 2 decimal places for fiat/stablecoin currencies (USDC, EURC, NGNT)', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ bids: [{ price: '0.1004' }], asks: [{ price: '0.1004' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ bids: [{ price: '0.1005' }], asks: [{ price: '0.1005' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ bids: [{ price: '0.1006' }], asks: [{ price: '0.1006' }] }),
      }) as unknown as typeof fetch;

    const roundDown = await convertAmount(10, 'XLM', 'USDC');
    expect(roundDown.amount).toBe(1.00);

    const roundHalfUp = await convertAmount(10, 'XLM', 'USDC');
    expect(roundHalfUp.amount).toBe(1.01);

    const roundUp = await convertAmount(10, 'XLM', 'USDC');
    expect(roundUp.amount).toBe(1.01);
  });

  it('rounds half up at 7 decimal places for XLM', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ bids: [{ price: '0.12345674' }], asks: [{ price: '0.12345674' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ bids: [{ price: '0.12345675' }], asks: [{ price: '0.12345675' }] }),
      }) as unknown as typeof fetch;

    const roundDown = await convertAmount(1, 'USDC', 'XLM');
    expect(roundDown.amount).toBe(0.1234567);

    const roundHalfUp = await convertAmount(1, 'USDC', 'XLM');
    expect(roundHalfUp.amount).toBe(0.1234568);
  });
});

describe('reject non-finite conversion inputs (#65)', () => {
  it('rejects NaN amount in computeConvertedAmount, convertAmount, and tryConvertAmount', async () => {
    expect(() => computeConvertedAmount(NaN, 1.5, 'USDC')).toThrowError();
    await expect(convertAmount(NaN, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(tryConvertAmount(NaN, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects positive and negative infinity inputs before calculation', async () => {
    expect(() => computeConvertedAmount(Infinity, 1.5, 'USDC')).toThrowError();
    expect(() => computeConvertedAmount(-Infinity, 1.5, 'USDC')).toThrowError();

    await expect(convertAmount(Infinity, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(convertAmount(-Infinity, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    await expect(tryConvertAmount(Infinity, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(tryConvertAmount(-Infinity, 'XLM', 'USDC')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
