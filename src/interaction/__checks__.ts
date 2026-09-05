import { CartridgeInsertion } from './Physics'

interface CartridgeCheck {
  readonly name: string
  readonly pass: boolean
  readonly detail: string
}

/** Numeric proof of the detent's resting pose and its render-on-demand contract. */
export function verifyCartridgeRest(): {
  readonly checked: number
  readonly passed: number
  readonly checks: readonly CartridgeCheck[]
} {
  const checks: CartridgeCheck[] = []
  for (const hz of [30, 60, 144]) {
    const cartridge = new CartridgeInsertion()
    const advance = (seconds: number): void => {
      for (let tick = 0; tick < hz * seconds; tick++) cartridge.step(1 / hz)
    }
    const check = (name: string, pass: boolean): void => {
      checks.push({
        name: `${hz} Hz: ${name}`,
        pass,
        detail: `u=${cartridge.u}; moving=${cartridge.moving}`,
      })
    }

    check('empty rests', !cartridge.moving)
    cartridge.push(1)
    check('insert command wakes', cartridge.moving)
    advance(10)
    check('seated rests at the detent', cartridge.seated && !cartridge.moving)
    const seatedAt = cartridge.u
    advance(1)
    check('rest preserves insertion depth', Math.abs(cartridge.u - seatedAt) < 1e-6 && seatedAt > 0.95 && seatedAt < 0.96)

    cartridge.nudge(0.6)
    check('wobble wakes without translation', cartridge.moving)
    advance(10)
    check('wobble settles', !cartridge.moving && Math.abs(cartridge.u - seatedAt) < 1e-6)

    cartridge.push(0)
    check('eject command wakes', cartridge.moving)
    advance(10)
    check('ejected rests', !cartridge.seated && !cartridge.moving && cartridge.u < 1e-6)
  }
  return { checked: checks.length, passed: checks.filter((check) => check.pass).length, checks }
}
