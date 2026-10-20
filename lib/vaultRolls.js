export const VAULT_DROP_RATE = 0.01;

export function passesVaultGate(random = Math.random, rate = VAULT_DROP_RATE) {
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
  return draw < rate;
}
