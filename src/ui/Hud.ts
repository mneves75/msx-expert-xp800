import './hud.css'
import type { PowerState } from '../core/types'

/**
 * HUD — camada de interface sobre a cena 3D.
 *
 * Desenho: painel de instrumento, não site. A linguagem visual é a do próprio painel
 * traseiro do XP-800 — contornos hairline de silkscreen com o rótulo em caixa-alta
 * encaixado na borda superior. Ver `hud.css`.
 *
 * ## Acoplamento
 *
 * A camada de interação é escrita por outro agente e pode chegar depois do HUD. Por isso
 * este módulo **não importa** nada dela: define o contrato estrutural {@link HudInteractions},
 * aceita qualquer objeto que se pareça com ele e o resolve em tempo de execução — pelo
 * argumento de {@link createHud}, por `window.__msxInteractions`, por `window.__msx`, ou
 * pelo evento `msx:interactions`.
 *
 * O estado **nunca é lido em laço**: o HUD assina a fonte (`subscribe`/`onChange`/
 * `addEventListener`) e só redesenha quando é notificado. Enquanto não há notificação,
 * as ações aplicam estado otimista local, que qualquer estado autoritativo sobrescreve.
 *
 * ## Atalhos
 *
 * Todos exigem **Alt (⌥)**. Sem modificador as teclas pertencem ao MSX — digitar `LOAD`
 * em BASIC não pode desligar a máquina.
 */

// ─── Contratos públicos ──────────────────────────────────────────────────────────

export type SlotId = 'A' | 'B'

/** Cartucho identificado. `name` é o rótulo em pt-BR mostrado ao usuário. */
export interface HudCartridge {
  readonly id: string
  readonly name: string
}

export interface HudSlotState {
  readonly cartridge: HudCartridge | null
}

/** Estado completo que o HUD sabe desenhar. Tudo o que ele exibe está aqui. */
export interface HudState {
  readonly power: PowerState
  readonly slotA: HudSlotState
  readonly slotB: HudSlotState
  /** Texto livre, ex.: `SCREEN 1 · 32×24`. `null` ⇒ derivado dos modos de exibição. */
  readonly displayMode: string | null
  readonly wireframe: boolean
  readonly xray: boolean
  readonly autoRotate: boolean
  readonly emulator: 'webmsx' | 'procedural' | null
  /** Mensagem transitória (erro de CDN, cartucho não encontrado…). */
  readonly note: string | null
  readonly noteTone: 'info' | 'alert'
}

export type HudIntentType =
  | 'power-toggle'
  | 'cartridge-insert'
  | 'cartridge-eject'
  | 'reset'
  | 'view-reset'
  | 'wireframe'
  | 'xray'
  | 'auto-rotate'

export interface HudIntent {
  readonly type: HudIntentType
  readonly slot: SlotId | null
  readonly romId: string | null
  readonly value: boolean | null
}

/**
 * O que o HUD espera da camada de interação. **Tudo é opcional** e resolvido
 * estruturalmente: o que existir é usado, o que faltar cai no fallback (rig de câmera,
 * evento `msx:intent` na janela, estado otimista local).
 *
 * Sinônimos aceitos em tempo de execução estão em {@link ACTIONS} — se você preferir
 * `toggleWireframe()` a `setWireframe(bool)`, funciona igual.
 */
export interface HudInteractions {
  getState?(): unknown
  subscribe?(listener: (state: unknown) => void): (() => void) | void
  setPower?(on: boolean): void
  togglePower?(): void
  insertCartridge?(slot: SlotId, romId?: string): void | Promise<void>
  ejectCartridge?(slot: SlotId): void
  reset?(): void
  resetView?(): void
  setWireframe?(on: boolean): void
  setXRay?(on: boolean): void
  setAutoRotate?(on: boolean): void
  /** Catálogo de cartuchos disponíveis, se houver. Alimenta os seletores de slot. */
  readonly cartridges?: readonly unknown[]
}

export interface HudHandle {
  readonly element: HTMLElement
  /** Empurra estado autoritativo para o HUD (alternativa a `subscribe`). */
  push(state: unknown): void
  getState(): HudState
  /** Mostra/oculta todo o cromo — usado por Alt+H e por capturas limpas. */
  setChromeVisible(visible: boolean): void
  dispose(): void
}

declare global {
  interface Window {
    /** Ponto de encontro opcional: a camada de interação pode se publicar aqui. */
    __msxInteractions?: unknown
    /** Handle do HUD, para o harness de captura esconder o cromo antes do shot. */
    __msxHud?: HudHandle
  }
}

// ─── Texto (pt-BR) ───────────────────────────────────────────────────────────────

const TXT = {
  title: 'Gradiente Expert XP-800',
  subtitle: 'Computador MSX brasileiro · 1985',
  groupStatus: 'Estado',
  groupPower: 'Energia',
  groupCartridges: 'Cartuchos',
  groupView: 'Vista',
  groupShortcuts: 'Atalhos',
  groupCredits: 'Créditos',
  readoutPower: 'Alimentação',
  readoutSlotA: 'Slot A',
  readoutSlotB: 'Slot B',
  readoutDisplay: 'Exibição',
  readoutEmulator: 'Emulação',
  powerOff: 'Desligado',
  powerOn: 'Ligado',
  powerWarming: 'Aquecendo',
  emptySlot: 'Sem cartucho',
  unknownCartridge: 'Cartucho',
  modeSolid: 'Sólido',
  modeWireframe: 'Aramado',
  modeXray: 'Raio-X',
  emulatorWebmsx: 'WebMSX · C-BIOS',
  // Sem cartucho esta é a rota normal, não uma falha: é o BASIC que roda no
  // renderizador próprio. Uma falha real do WebMSX tem aviso próprio.
  emulatorProcedural: 'MSX BASIC · interno',
  emulatorIdle: 'Inativa',
  turnOn: 'Ligar',
  turnOff: 'Desligar',
  insert: 'Inserir cartucho',
  eject: 'Ejetar',
  loadRom: 'Carregar ROM…',
  loadRomHint:
    'Roda um arquivo .rom seu no cartucho preto — o arquivo fica só no seu navegador.',
  loadRomUnavailable: 'A camada de interação ainda não conectou — tente novamente.',
  loadRomReadError: 'Não foi possível ler o arquivo escolhido.',
  loadRomTooBig: 'Arquivo acima de 2 MB — nada foi carregado.',
  reset: 'Reiniciar',
  resetHint: 'Empurra a tampa do slot A — o Expert não tem tecla de reset.',
  resetView: 'Redefinir vista',
  wireframe: 'Aramado',
  xray: 'Raio-X',
  autoRotate: 'Rotação automática',
  legendOrbit: 'Orbitar',
  legendPan: 'Deslocar',
  legendZoom: 'Zoom',
  legendOrbitFine: 'arrastar',
  legendOrbitCoarse: 'um dedo',
  legendPanFine: 'botão direito',
  legendPanCoarse: 'dois dedos',
  legendZoomFine: 'rolar',
  legendZoomCoarse: 'pinça',
  sheetOpen: 'Painel',
  sheetClose: 'Fechar',
  sheetAriaOpen: 'Abrir o painel de controles',
  sheetAriaClose: 'Fechar o painel de controles',
  noBridge:
    'Camada de interação não conectada — os comandos estão sendo apenas anunciados.',
} as const

/** Rótulo do modificador conforme a plataforma. */
function altLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Mac|iPhone|iPad|iPod/i.test(ua) ? '⌥' : 'Alt'
}

// ─── Utilidades de tipo (sem `any`) ──────────────────────────────────────────────

type Unsubscribe = () => void
type Fn = (...args: readonly unknown[]) => unknown

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function methodOf(target: unknown, name: string): Fn | null {
  if (!isRecord(target)) return null
  const value = target[name]
  return typeof value === 'function' ? (value as Fn) : null
}

/** Chama o primeiro método existente entre `names`. Retorna `true` se algo rodou. */
function invoke(target: unknown, names: readonly string[], args: readonly unknown[]): boolean {
  for (const name of names) {
    const fn = methodOf(target, name)
    if (!fn) continue
    try {
      const result = fn.call(target, ...args)
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.error(`[HUD] "${name}" rejeitou:`, error)
        })
      }
    } catch (error) {
      console.error(`[HUD] "${name}" lançou:`, error)
    }
    return true
  }
  return false
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

type Probe = { readonly found: true; readonly value: unknown } | { readonly found: false }

const NOT_FOUND: Probe = { found: false }

function lookup(source: unknown, names: readonly string[]): Probe {
  if (!isRecord(source)) return NOT_FOUND
  for (const name of names) {
    if (name in source) return { found: true, value: source[name] }
  }
  return NOT_FOUND
}

function probeValue(probe: Probe): unknown {
  return probe.found ? probe.value : undefined
}

function readBool(probe: Probe, fallback: boolean): boolean {
  if (!probe.found) return fallback
  const value = probe.value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return /^(1|true|on|sim|ligado)$/i.test(value)
  return fallback
}

function readText(probe: Probe, fallback: string | null): string | null {
  if (!probe.found) return fallback
  const value = probe.value
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (value === null || value === undefined) return null
  return fallback
}

// ─── Normalização do estado externo ──────────────────────────────────────────────

const EMPTY_SLOT_WORDS = /^(|vazio|sem cartucho|nenhum|none|empty|null)$/i

function readCartridge(value: unknown): HudCartridge | null {
  if (value === null || value === undefined || value === false) return null
  if (typeof value === 'string') {
    const name = value.trim()
    return EMPTY_SLOT_WORDS.test(name) ? null : { id: name, name }
  }
  if (!isRecord(value)) return null

  // Um invólucro explícito (`{ cartridge: … }`) sempre vence: a chave nomeia o conteúdo.
  const wrapper = lookup(value, ['cartridge', 'cart'])
  if (wrapper.found) return readCartridge(wrapper.value)

  // Campos planos vêm antes de `rom`/`game` — senão um `{ id, name, rom: 'x.rom' }`
  // seria lido como se `rom` fosse o cartucho.
  const name = readText(lookup(value, ['name', 'title', 'label', 'nome']), null)
  const id = readText(lookup(value, ['id', 'romId', 'slug']), null)
  if (name !== null || id !== null) {
    const resolved = name ?? id ?? TXT.unknownCartridge
    return { id: id ?? resolved, name: resolved }
  }

  const nested = lookup(value, ['rom', 'game'])
  if (nested.found) return readCartridge(nested.value)
  return null
}

function readSlotProbe(state: unknown, slot: SlotId): Probe {
  const direct = lookup(state, [
    `slot${slot}`,
    `slot${slot.toLowerCase()}`,
    `cartridge${slot}`,
    `cart${slot}`,
  ])
  if (direct.found) return direct
  for (const container of ['slots', 'cartridges', 'carts']) {
    const outer = lookup(state, [container])
    if (!outer.found) continue
    const inner = lookup(outer.value, [slot, slot.toLowerCase()])
    if (inner.found) return inner
  }
  return NOT_FOUND
}

function readPower(state: unknown, previous: PowerState): PowerState {
  const grouped = lookup(state, ['power', 'powerState'])
  if (grouped.found) {
    const value = grouped.value
    if (typeof value === 'boolean') return { on: value, warmth: value ? 1 : 0 }
    if (isRecord(value)) {
      const on = readBool(lookup(value, ['on', 'powered', 'isOn']), previous.on)
      const warmthProbe = lookup(value, ['warmth', 'warmUp', 'warmup'])
      const warmth =
        warmthProbe.found && typeof warmthProbe.value === 'number'
          ? clamp01(warmthProbe.value)
          : on
            ? previous.warmth
            : 0
      return { on, warmth }
    }
  }
  const flat = lookup(state, ['powered', 'isOn', 'on'])
  if (!flat.found) return previous
  const on = readBool(flat, previous.on)
  const warmthProbe = lookup(state, ['warmth', 'warmUp', 'warmup'])
  const warmth =
    warmthProbe.found && typeof warmthProbe.value === 'number'
      ? clamp01(warmthProbe.value)
      : on
        ? previous.warmth
        : 0
  return { on, warmth }
}

function readEmulator(state: unknown, previous: HudState['emulator']): HudState['emulator'] {
  const probe = lookup(state, ['emulator', 'screenSource', 'source', 'kind'])
  if (!probe.found) return previous
  const raw = isRecord(probe.value) ? lookup(probe.value, ['kind', 'type', 'name']) : probe
  const text = readText(raw, null)
  if (text === null) return null
  if (/webmsx|wmsx/i.test(text)) return 'webmsx'
  if (/procedur|fallback|tms/i.test(text)) return 'procedural'
  return previous
}

/**
 * Funde um objeto de estado desconhecido no {@link HudState}. Só sobrescreve o que
 * realmente veio — uma fonte que reporta apenas `power` não zera os slots.
 */
function mergeState(previous: HudState, incoming: unknown): HudState {
  if (!isRecord(incoming)) return previous
  // Aceita tanto `{ … }` quanto `{ state: { … } }` / `{ detail: { … } }`.
  const nested = lookup(incoming, ['state', 'hud', 'detail'])
  const state = nested.found && isRecord(nested.value) ? nested.value : incoming

  const slotAProbe = readSlotProbe(state, 'A')
  const slotBProbe = readSlotProbe(state, 'B')
  // Um erro tem precedência sobre o aviso comum e muda o tom.
  const errorText = readText(lookup(state, ['error']), null)
  const noteProbe = errorText === null ? lookup(state, ['note', 'message', 'aviso']) : NOT_FOUND

  return {
    power: readPower(state, previous.power),
    slotA: slotAProbe.found ? { cartridge: readCartridge(slotAProbe.value) } : previous.slotA,
    slotB: slotBProbe.found ? { cartridge: readCartridge(slotBProbe.value) } : previous.slotB,
    displayMode: readText(
      lookup(state, ['displayMode', 'screenMode', 'videoMode']),
      previous.displayMode,
    ),
    wireframe: readBool(lookup(state, ['wireframe', 'isWireframe']), previous.wireframe),
    xray: readBool(lookup(state, ['xray', 'xRay', 'isXray']), previous.xray),
    autoRotate: readBool(
      lookup(state, ['autoRotate', 'autoRotating', 'autorotate']),
      previous.autoRotate,
    ),
    emulator: readEmulator(state, previous.emulator),
    note: errorText ?? readText(noteProbe, previous.note),
    noteTone: errorText === null ? 'info' : 'alert',
  }
}

function readCatalogue(source: unknown): readonly HudCartridge[] {
  const raw = probeValue(lookup(source, ['cartridges', 'catalog', 'roms', 'library']))
  if (!Array.isArray(raw)) return []
  const list: readonly unknown[] = raw
  const out: HudCartridge[] = []
  for (const entry of list) {
    const cartridge = readCartridge(entry)
    if (cartridge) out.push(cartridge)
  }
  return out
}

// ─── Ponte com a camada de interação ─────────────────────────────────────────────

/** Sinônimos aceitos para cada ação, em ordem de preferência. */
const ACTIONS = {
  setPower: ['setPower', 'power', 'setPowerOn'],
  togglePower: ['togglePower', 'toggle'],
  insert: ['insertCartridge', 'insert', 'loadCartridge', 'loadRom'],
  eject: ['ejectCartridge', 'eject', 'removeCartridge'],
  loadLocalRom: ['loadLocalRom'],
  reset: ['reset', 'softReset', 'nudgeSlotCover', 'pushSlotCover', 'resetMachine'],
  resetView: ['resetView', 'resetCamera', 'resetPose'],
  setWireframe: ['setWireframe', 'wireframe'],
  toggleWireframe: ['toggleWireframe'],
  setXray: ['setXRay', 'setXray', 'xray'],
  toggleXray: ['toggleXRay', 'toggleXray'],
  setAutoRotate: ['setAutoRotate', 'autoRotate'],
  toggleAutoRotate: ['toggleAutoRotate'],
  subscribe: ['subscribe', 'onChange', 'onStateChange', 'addListener', 'watch'],
  unsubscribe: ['unsubscribe', 'offChange', 'removeListener', 'off'],
  getState: ['getState', 'snapshot', 'state'],
} as const

const BRIDGE_PROBE: readonly string[] = [
  ...ACTIONS.subscribe,
  ...ACTIONS.getState,
  ...ACTIONS.togglePower,
  ...ACTIONS.setPower,
  ...ACTIONS.insert,
  ...ACTIONS.eject,
  ...ACTIONS.resetView,
]

function looksLikeInteractions(value: unknown): boolean {
  if (!isRecord(value)) return false
  return BRIDGE_PROBE.some((name) => typeof value[name] === 'function')
}

interface CameraRigLike {
  resetPose(immediate?: boolean): void
  setAutoRotate(enabled: boolean): void
}

function asCameraRig(value: unknown): CameraRigLike | null {
  if (!isRecord(value)) return null
  const rig = lookup(value, ['cameraRig', 'rig'])
  const candidate = rig.found ? rig.value : value
  if (
    methodOf(candidate, 'resetPose') !== null &&
    methodOf(candidate, 'setAutoRotate') !== null
  ) {
    return candidate as unknown as CameraRigLike
  }
  return null
}

/** Momentos de religação: a camada de interação pode carregar depois do HUD. */
const REBIND_DELAYS_MS = [0, 80, 240, 700, 1600, 3200] as const

// ─── Helpers de DOM ──────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Escreve só quando muda — evita que leitores de tela reanunciem o mesmo valor. */
function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

/** Grupo com contorno hairline e rótulo encaixado na borda — vide painel traseiro. */
function group(title: string, id: string): { section: HTMLElement; body: HTMLElement } {
  const section = el('section', 'hud__group')
  const head = el('div', 'hud__group-head')
  const heading = el('h2', 'hud__group-title', title)
  heading.id = `hud-grp-${id}`
  section.setAttribute('aria-labelledby', heading.id)
  head.appendChild(heading)
  const body = el('div', 'hud__group-body')
  section.append(head, body)
  return { section, body }
}

function readoutRow(label: string): { row: DocumentFragment; value: HTMLElement } {
  const fragment = document.createDocumentFragment()
  const term = el('dt', undefined, label)
  const value = el('dd')
  fragment.append(term, value)
  return { row: fragment, value }
}

function actionButton(label: string, shortcut: string | null): HTMLButtonElement {
  const button = el('button', 'hud__btn')
  button.type = 'button'
  button.appendChild(el('span', 'hud__btn-label', label))
  if (shortcut !== null) {
    const key = el('span', 'hud__btn-key', shortcut)
    // O atalho é decoração: o leitor de tela já recebe o rótulo (e o aria-label).
    key.setAttribute('aria-hidden', 'true')
    button.appendChild(key)
  }
  return button
}

/** Alternador: mesmo corpo do botão de ação, mais um LED de estado à esquerda. */
function toggleButton(label: string, shortcut: string): HTMLButtonElement {
  const button = actionButton(label, shortcut)
  const led = el('span', 'hud__led')
  led.setAttribute('aria-hidden', 'true')
  button.insertBefore(led, button.firstChild)
  button.setAttribute('aria-pressed', 'false')
  return button
}

function legendRow(term: string, fine: string, coarse: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  fragment.appendChild(el('dt', undefined, term))
  const value = el('dd')
  value.appendChild(el('span', 'hud__pointer hud__pointer--fine', fine))
  value.appendChild(el('span', 'hud__pointer hud__pointer--coarse', coarse))
  fragment.appendChild(value)
  return fragment
}

// ─── Estado inicial ──────────────────────────────────────────────────────────────

function initialState(): HudState {
  return {
    power: { on: false, warmth: 0 },
    slotA: { cartridge: null },
    slotB: { cartridge: null },
    displayMode: null,
    wireframe: false,
    xray: false,
    autoRotate: false,
    emulator: null,
    note: null,
    noteTone: 'info',
  }
}

// ─── Implementação ───────────────────────────────────────────────────────────────

interface SlotControls {
  readonly select: HTMLSelectElement
  readonly insert: HTMLButtonElement
  readonly eject: HTMLButtonElement
}

class Hud implements HudHandle {
  readonly element: HTMLElement

  private state: HudState = initialState()
  private lastAnnounced = ''
  private bridge: unknown = null
  private rig: CameraRigLike | null = null
  private unsubscribe: Unsubscribe | null = null
  private catalogue: readonly HudCartridge[] = []
  private readonly timers: number[] = []
  private disposed = false
  private warnedNoBridge = false
  private sheetOpen = false
  private sheetDrag: { readonly pointerId: number; readonly x: number; readonly y: number } | null =
    null
  private chromeVisible = true

  private readonly mobileQuery: MediaQueryList | null
  private readonly alt = altLabel()

  // Nós que o render atualiza.
  private readonly powerValue: HTMLElement
  private readonly powerLamp: HTMLElement
  private readonly slotValues: Readonly<Record<SlotId, HTMLElement>>
  private readonly displayValue: HTMLElement
  private readonly emulatorValue: HTMLElement
  private readonly noteNode: HTMLElement
  private readonly announcer: HTMLElement
  private readonly powerButton: HTMLButtonElement
  private readonly slotControls: Readonly<Record<SlotId, SlotControls>>
  private readonly wireframeButton: HTMLButtonElement
  private readonly xrayButton: HTMLButtonElement
  private readonly autoRotateButton: HTMLButtonElement
  private readonly sheetToggle: HTMLButtonElement
  private readonly sheetToggleState: HTMLElement
  private readonly sheetClose: HTMLButtonElement
  private readonly console: HTMLElement

  constructor(source: unknown) {
    this.mobileQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 46rem), (max-height: 30rem) and (pointer: coarse)')
        : null

    const root = el('div', 'hud')
    root.dataset['boot'] = '1'
    this.element = root

    // ── Bloco-título ──────────────────────────────────────────────────────────
    const brand = el('header', 'hud__brand')
    const brandRow = el('div', 'hud__brand-row')
    const title = el('h1', 'hud__title', TXT.title)
    const msx = el('span', 'hud__msx', 'MSX')
    msx.setAttribute('aria-hidden', 'true')
    brandRow.append(title, msx)
    brand.append(brandRow, el('p', 'hud__subtitle', TXT.subtitle))
    root.appendChild(brand)

    // ── Console ───────────────────────────────────────────────────────────────
    const sheetBackdrop = el('div', 'hud__sheet-backdrop')
    sheetBackdrop.setAttribute('aria-hidden', 'true')
    root.appendChild(sheetBackdrop)

    const consoleEl = el('div', 'hud__console')
    consoleEl.id = 'hud-console'
    this.console = consoleEl

    const sheetHead = el('div', 'hud__sheet-head')
    const grip = el('span', 'hud__sheet-grip')
    grip.setAttribute('aria-hidden', 'true')
    const sheetTitle = el('span', 'hud__group-title', TXT.sheetOpen)
    sheetTitle.id = 'hud-sheet-title'
    this.sheetClose = el('button', 'hud__sheet-close')
    this.sheetClose.type = 'button'
    this.sheetClose.textContent = TXT.sheetClose
    this.sheetClose.setAttribute('aria-label', TXT.sheetAriaClose)
    sheetHead.append(grip, sheetTitle, this.sheetClose)
    consoleEl.appendChild(sheetHead)

    const left = el('div', 'hud__dock hud__dock--left')
    const right = el('div', 'hud__dock hud__dock--right')
    consoleEl.append(left, right)

    // ── Grupo: estado ─────────────────────────────────────────────────────────
    const statusGroup = group(TXT.groupStatus, 'estado')
    const readouts = el('dl', 'hud__readouts')

    // A região viva anuncia apenas mudanças grossas. A rampa de aquecimento do CRT
    // atualiza o texto visível dezenas de vezes por segundo — anunciar isso seria
    // insuportável em leitor de tela.
    this.announcer = el('p', 'hud__sr')
    this.announcer.setAttribute('role', 'status')
    this.announcer.setAttribute('aria-live', 'polite')

    const powerRow = readoutRow(TXT.readoutPower)
    this.powerLamp = el('span', 'hud__lamp')
    this.powerLamp.setAttribute('aria-hidden', 'true')
    this.powerValue = el('span', 'hud__readout-text')
    powerRow.value.append(this.powerLamp, this.powerValue)

    const slotARow = readoutRow(TXT.readoutSlotA)
    const slotBRow = readoutRow(TXT.readoutSlotB)
    const displayRow = readoutRow(TXT.readoutDisplay)
    const emulatorRow = readoutRow(TXT.readoutEmulator)
    this.slotValues = { A: slotARow.value, B: slotBRow.value }
    this.displayValue = displayRow.value
    this.emulatorValue = emulatorRow.value

    readouts.append(powerRow.row, slotARow.row, slotBRow.row, displayRow.row, emulatorRow.row)
    this.noteNode = el('p', 'hud__note')
    this.noteNode.hidden = true
    statusGroup.body.append(readouts, this.noteNode, this.announcer)
    left.appendChild(statusGroup.section)

    // ── Grupo: energia + sistema ──────────────────────────────────────────────
    const powerGroup = group(TXT.groupPower, 'energia')
    const powerStack = el('div', 'hud__stack')
    this.powerButton = actionButton(TXT.turnOn, `${this.alt} L`)
    this.powerButton.classList.add('hud__btn--primary')
    const resetButton = actionButton(TXT.reset, `${this.alt} R`)
    resetButton.title = TXT.resetHint
    resetButton.setAttribute('aria-label', `${TXT.reset} — ${TXT.resetHint}`)
    powerStack.append(this.powerButton, resetButton)
    powerGroup.body.append(powerStack, el('p', 'hud__hint', TXT.resetHint))
    left.appendChild(powerGroup.section)

    // ── Grupo: cartuchos ──────────────────────────────────────────────────────
    const cartGroup = group(TXT.groupCartridges, 'cartuchos')
    const cartStack = el('div', 'hud__stack')
    const controlsA = this.buildSlotRow('A', cartStack)
    const controlsB = this.buildSlotRow('B', cartStack)
    this.slotControls = { A: controlsA, B: controlsB }
    cartGroup.body.appendChild(cartStack)

    // Carregar ROM local: input de arquivo escondido atrás de um botão normal.
    // O arquivo nunca sai do navegador — vai por bytes para a camada de
    // interação, que o instala no cartucho preto genérico.
    const romInput = document.createElement('input')
    romInput.type = 'file'
    romInput.accept = '.rom,.bin,.mx1,.mx2'
    romInput.hidden = true
    romInput.addEventListener('change', () => {
      const file = romInput.files?.[0]
      romInput.value = ''
      if (file === undefined) return
      // Recusa ANTES de ler: `.bin` aceita seleção acidental de imagens enormes,
      // e `arrayBuffer()` alocaria o arquivo inteiro só para rejeitá-lo depois.
      if (file.size > 2 * 1024 * 1024) {
        this.patch({ note: TXT.loadRomTooBig, noteTone: 'alert' })
        return
      }
      file
        .arrayBuffer()
        .then((buffer) => {
          // `invoke` devolve "handler existe e foi chamado", não o retorno dele:
          // uma ROM entregue porém recusada mantém a nota precisa (romInvalid/
          // romTooBig) publicada pela camada de interação.
          const delivered = invoke(this.bridge, ACTIONS.loadLocalRom, [
            new Uint8Array(buffer),
            file.name,
          ])
          if (!delivered) this.patch({ note: TXT.loadRomUnavailable, noteTone: 'alert' })
        })
        .catch(() => {
          this.patch({ note: TXT.loadRomReadError, noteTone: 'alert' })
        })
    })
    const loadRomButton = actionButton(TXT.loadRom, null)
    loadRomButton.title = TXT.loadRomHint
    loadRomButton.setAttribute('aria-label', `${TXT.loadRom} — ${TXT.loadRomHint}`)
    loadRomButton.addEventListener('click', () => romInput.click())
    cartGroup.body.append(loadRomButton, romInput, el('p', 'hud__hint', TXT.loadRomHint))
    left.appendChild(cartGroup.section)

    // ── Grupo: vista ──────────────────────────────────────────────────────────
    const viewGroup = group(TXT.groupView, 'vista')
    const legend = el('dl', 'hud__legend')
    legend.append(
      legendRow(TXT.legendOrbit, TXT.legendOrbitFine, TXT.legendOrbitCoarse),
      legendRow(TXT.legendPan, TXT.legendPanFine, TXT.legendPanCoarse),
      legendRow(TXT.legendZoom, TXT.legendZoomFine, TXT.legendZoomCoarse),
    )
    const viewStack = el('div', 'hud__stack')
    const resetViewButton = actionButton(TXT.resetView, `${this.alt} V`)
    this.wireframeButton = toggleButton(TXT.wireframe, `${this.alt} W`)
    this.xrayButton = toggleButton(TXT.xray, `${this.alt} X`)
    this.autoRotateButton = toggleButton(TXT.autoRotate, `${this.alt} G`)
    viewStack.append(
      resetViewButton,
      this.wireframeButton,
      this.xrayButton,
      this.autoRotateButton,
    )
    viewGroup.body.append(legend, viewStack)
    right.appendChild(viewGroup.section)

    // ── Grupo: atalhos ────────────────────────────────────────────────────────
    const shortcutGroup = group(TXT.groupShortcuts, 'atalhos')
    const shortcuts = el('dl', 'hud__shortcuts')
    // Rótulos curtos: a tabela é de referência rápida, o rótulo completo está no botão.
    const pairs: readonly (readonly [string, string])[] = [
      [`${this.alt} L`, 'Liga / desliga'],
      [`${this.alt} A`, 'Cartucho A'],
      [`${this.alt} B`, 'Cartucho B'],
      [`${this.alt} R`, TXT.reset],
      [`${this.alt} V`, 'Vista'],
      [`${this.alt} W`, TXT.wireframe],
      [`${this.alt} X`, TXT.xray],
      [`${this.alt} G`, 'Girar'],
      [`${this.alt} H`, 'Ocultar'],
    ]
    for (const pair of pairs) {
      shortcuts.appendChild(el('dt', undefined, pair[0]))
      shortcuts.appendChild(el('dd', undefined, pair[1]))
    }
    shortcutGroup.body.append(
      shortcuts,
      el(
        'p',
        'hud__hint',
        `Os atalhos exigem ${this.alt} para não disputar as teclas com o MSX.`,
      ),
    )
    right.appendChild(shortcutGroup.section)

    // ── Grupo: créditos ───────────────────────────────────────────────────────
    const creditGroup = group(TXT.groupCredits, 'creditos')
    creditGroup.body.appendChild(this.buildCredit())
    right.appendChild(creditGroup.section)

    root.appendChild(consoleEl)

    // ── Botão do bottom sheet ─────────────────────────────────────────────────
    this.sheetToggle = el('button', 'hud__sheet-toggle')
    this.sheetToggle.type = 'button'
    this.sheetToggle.setAttribute('aria-expanded', 'false')
    this.sheetToggle.setAttribute('aria-controls', 'hud-console')
    this.sheetToggle.setAttribute('aria-label', TXT.sheetAriaOpen)
    this.sheetToggle.appendChild(el('span', undefined, TXT.sheetOpen))
    this.sheetToggleState = el('span', 'hud__sheet-toggle-state', TXT.powerOff)
    this.sheetToggle.appendChild(this.sheetToggleState)
    root.appendChild(this.sheetToggle)

    // ── Eventos ───────────────────────────────────────────────────────────────
    this.powerButton.addEventListener('click', this.onPowerClick)
    resetButton.addEventListener('click', this.onResetClick)
    resetViewButton.addEventListener('click', this.onResetViewClick)
    this.wireframeButton.addEventListener('click', this.onWireframeClick)
    this.xrayButton.addEventListener('click', this.onXrayClick)
    this.autoRotateButton.addEventListener('click', this.onAutoRotateClick)
    this.sheetToggle.addEventListener('click', this.onSheetOpen)
    this.sheetClose.addEventListener('click', this.onSheetClose)
    sheetBackdrop.addEventListener('click', this.onSheetClose)
    sheetHead.addEventListener('pointerdown', this.onSheetDragStart)

    window.addEventListener('keydown', this.onKeyDown, { capture: true })
    window.addEventListener('pointerup', this.onSheetDragEnd)
    window.addEventListener('pointercancel', this.onSheetDragCancel)
    window.addEventListener('msx:interactions', this.onBridgeAnnounced)
    window.addEventListener('msx:state', this.onStateAnnounced)
    this.mobileQuery?.addEventListener('change', this.onBreakpointChange)

    document.body.appendChild(root)

    this.bind(source)
    this.scheduleRebind(source)
    this.applySheet()
    this.render()
    this.revealWhenReady(source)
  }

  // ── Construção auxiliar ─────────────────────────────────────────────────────

  private buildSlotRow(slot: SlotId, host: HTMLElement): SlotControls {
    const row = el('div', 'hud__slot')
    row.appendChild(el('span', 'hud__row-label', `Slot ${slot}`))

    const select = el('select', 'hud__select')
    select.hidden = true
    select.setAttribute('aria-label', `Escolher o cartucho do slot ${slot}`)

    const insert = actionButton(TXT.insert, `${this.alt} ${slot}`)
    insert.setAttribute('aria-label', `${TXT.insert} no slot ${slot}`)
    insert.addEventListener('click', () => {
      this.insertCartridge(slot)
    })

    const eject = actionButton(TXT.eject, null)
    eject.classList.add('hud__btn--compact')
    eject.setAttribute('aria-label', `${TXT.eject} o cartucho do slot ${slot}`)
    eject.addEventListener('click', () => {
      this.ejectCartridge(slot)
    })

    row.append(select, insert, eject)
    host.appendChild(row)
    return { select, insert, eject }
  }

  private buildCredit(): HTMLElement {
    const credit = el('p', 'hud__credit')
    credit.append(
      'Emulação por ',
      el('strong', undefined, 'WebMSX'),
      ' com C-BIOS, carregada sob demanda do CDN jsDelivr com verificação SRI — nada é ' +
        'redistribuído aqui. Homenagem sem vínculo oficial: MSX, Gradiente e Expert são ' +
        'marcas de seus respectivos titulares.',
    )
    return credit
  }

  // ── Ponte ───────────────────────────────────────────────────────────────────

  /** Tenta descobrir a camada de interação. Retorna `true` quando encontra. */
  private bind(source: unknown): boolean {
    if (this.disposed) return false
    if (this.rig === null) this.rig = asCameraRig(source) ?? asCameraRig(window.__msx)

    if (this.bridge !== null) return true

    const candidates: unknown[] = [
      source,
      probeValue(lookup(source, ['interactions', 'interaction', 'hud'])),
      window.__msxInteractions,
      probeValue(lookup(window.__msx, ['interactions', 'interaction'])),
    ]
    // `main.ts` guarda cada sistema iniciado em `window.__msx._systems` (propriedade
    // não-enumerável) — e, quando a camada de interação também é um `SceneModule`, no
    // registro de módulos do próprio Engine. Varremos os dois: é a única forma de nos
    // acharmos sem que o outro agente precise nos anunciar.
    for (const bag of [
      probeValue(lookup(window.__msx, ['_systems'])),
      probeValue(lookup(probeValue(lookup(window.__msx, ['engine'])), ['modules'])),
      probeValue(lookup(probeValue(lookup(source, ['engine'])), ['modules'])),
    ]) {
      if (!Array.isArray(bag)) continue
      const list: readonly unknown[] = bag
      candidates.push(...list)
    }

    for (const candidate of candidates) {
      if (!looksLikeInteractions(candidate)) continue
      this.attach(candidate)
      return true
    }
    return false
  }

  private attach(bridge: unknown): void {
    this.bridge = bridge
    this.catalogue = readCatalogue(bridge)
    this.populateCatalogue()

    for (const name of ACTIONS.subscribe) {
      const fn = methodOf(bridge, name)
      if (!fn) continue
      try {
        const result = fn.call(bridge, this.onExternalState)
        this.unsubscribe =
          typeof result === 'function'
            ? (result as Unsubscribe)
            : (): void => {
                invoke(bridge, ACTIONS.unsubscribe, [this.onExternalState])
              }
        break
      } catch (error) {
        console.error(`[HUD] falha ao assinar via "${name}":`, error)
      }
    }

    if (this.unsubscribe === null) {
      const target = bridge
      if (methodOf(target, 'addEventListener')) {
        const listener = this.onDomStateEvent
        for (const type of ['change', 'statechange', 'update']) {
          invoke(target, ['addEventListener'], [type, listener])
        }
        this.unsubscribe = (): void => {
          for (const type of ['change', 'statechange', 'update']) {
            invoke(target, ['removeEventListener'], [type, listener])
          }
        }
      }
    }

    for (const name of ACTIONS.getState) {
      const fn = methodOf(bridge, name)
      if (!fn) continue
      try {
        this.push(fn.call(bridge))
      } catch (error) {
        console.error(`[HUD] "${name}" lançou:`, error)
      }
      break
    }
    if (this.state.note === TXT.noBridge) {
      this.state = { ...this.state, note: null, noteTone: 'info' }
      this.render()
    }
  }

  private scheduleRebind(source: unknown): void {
    for (const delay of REBIND_DELAYS_MS) {
      const id = window.setTimeout(() => {
        if (this.disposed || this.bridge !== null) return
        this.bind(source)
      }, delay)
      this.timers.push(id)
    }
  }

  /** Só aparece depois do primeiro frame, para não piscar sobre o véu de boot. */
  private revealWhenReady(source: unknown): void {
    const reveal = (): void => {
      if (this.disposed) return
      delete this.element.dataset['boot']
    }
    const engine = isRecord(source) ? lookup(source, ['engine']) : NOT_FOUND
    if (engine.found && methodOf(engine.value, 'onReady')) {
      invoke(engine.value, ['onReady'], [reveal])
      return
    }
    this.timers.push(window.setTimeout(reveal, window.__msxReady === true ? 0 : 900))
  }

  /**
   * Executa uma ação: método da ponte, senão fallback local, senão evento
   * `msx:intent` na janela para quem quiser escutar.
   */
  private dispatch(intent: HudIntent, run: () => boolean): void {
    if (run()) return
    window.dispatchEvent(new CustomEvent<HudIntent>('msx:intent', { detail: intent }))
    if (this.warnedNoBridge) return
    this.warnedNoBridge = true
    console.info('[HUD] nenhuma camada de interação conectada — emitindo "msx:intent".')
    this.state = { ...this.state, note: TXT.noBridge, noteTone: 'info' }
  }

  // ── Ações ───────────────────────────────────────────────────────────────────

  private readonly onPowerClick = (): void => {
    this.togglePower()
  }

  private togglePower(): void {
    const next = !this.state.power.on
    this.dispatch(
      { type: 'power-toggle', slot: null, romId: null, value: next },
      () =>
        invoke(this.bridge, ACTIONS.setPower, [next]) ||
        invoke(this.bridge, ACTIONS.togglePower, []),
    )
    // Sem fonte de estado não há rampa para mostrar: fingir "Aquecendo · 0%" para
    // sempre seria pior que assumir a máquina quente. Qualquer `push` corrige.
    const warmth = next ? (this.bridge === null ? 1 : this.state.power.warmth) : 0
    this.patch({ power: { on: next, warmth } })
  }

  private insertCartridge(slot: SlotId): void {
    const controls = this.slotControls[slot]
    const chosen = this.catalogue.find((item) => item.id === controls.select.value) ?? null
    const romId = chosen?.id ?? null
    this.dispatch({ type: 'cartridge-insert', slot, romId, value: null }, () =>
      invoke(this.bridge, ACTIONS.insert, romId === null ? [slot] : [slot, romId]),
    )
    const cartridge: HudCartridge = chosen ?? {
      id: TXT.unknownCartridge,
      name: TXT.unknownCartridge,
    }
    this.patch(slot === 'A' ? { slotA: { cartridge } } : { slotB: { cartridge } })
  }

  private ejectCartridge(slot: SlotId): void {
    this.dispatch({ type: 'cartridge-eject', slot, romId: null, value: null }, () =>
      invoke(this.bridge, ACTIONS.eject, [slot]),
    )
    this.patch(slot === 'A' ? { slotA: { cartridge: null } } : { slotB: { cartridge: null } })
  }

  private readonly onResetClick = (): void => {
    // Reset autêntico: empurrar a tampa do slot A. A máquina não tem tecla de reset.
    this.dispatch({ type: 'reset', slot: 'A', romId: null, value: null }, () =>
      invoke(this.bridge, ACTIONS.reset, ['A']),
    )
  }

  private readonly onResetViewClick = (): void => {
    this.dispatch({ type: 'view-reset', slot: null, romId: null, value: null }, () => {
      if (invoke(this.bridge, ACTIONS.resetView, [])) return true
      if (this.rig === null) return false
      try {
        this.rig.resetPose(false)
        return true
      } catch (error) {
        console.error('[HUD] resetPose falhou:', error)
        return false
      }
    })
  }

  private readonly onWireframeClick = (): void => {
    const next = !this.state.wireframe
    this.dispatch(
      { type: 'wireframe', slot: null, romId: null, value: next },
      () =>
        invoke(this.bridge, ACTIONS.setWireframe, [next]) ||
        invoke(this.bridge, ACTIONS.toggleWireframe, []),
    )
    this.patch({ wireframe: next })
  }

  private readonly onXrayClick = (): void => {
    const next = !this.state.xray
    this.dispatch(
      { type: 'xray', slot: null, romId: null, value: next },
      () =>
        invoke(this.bridge, ACTIONS.setXray, [next]) ||
        invoke(this.bridge, ACTIONS.toggleXray, []),
    )
    this.patch({ xray: next })
  }

  private readonly onAutoRotateClick = (): void => {
    const next = !this.state.autoRotate
    this.dispatch({ type: 'auto-rotate', slot: null, romId: null, value: next }, () => {
      if (
        invoke(this.bridge, ACTIONS.setAutoRotate, [next]) ||
        invoke(this.bridge, ACTIONS.toggleAutoRotate, [])
      ) {
        return true
      }
      if (this.rig === null) return false
      try {
        this.rig.setAutoRotate(next)
        return true
      } catch (error) {
        console.error('[HUD] setAutoRotate falhou:', error)
        return false
      }
    })
    this.patch({ autoRotate: next })
  }

  // ── Bottom sheet ────────────────────────────────────────────────────────────

  private readonly onSheetOpen = (): void => {
    this.setSheet(true)
    this.sheetClose.focus()
  }

  private readonly onSheetClose = (): void => {
    this.setSheet(false)
    this.sheetToggle.focus()
  }

  private readonly onSheetDragStart = (event: PointerEvent): void => {
    if (!this.sheetOpen || !this.isMobile || !event.isPrimary || event.button !== 0) return
    this.sheetDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  private readonly onSheetDragEnd = (event: PointerEvent): void => {
    const start = this.sheetDrag
    if (start === null || event.pointerId !== start.pointerId) return
    this.sheetDrag = null
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (dy < 56 || dy <= Math.abs(dx)) return
    event.preventDefault()
    this.onSheetClose()
  }

  private readonly onSheetDragCancel = (event: PointerEvent): void => {
    if (this.sheetDrag?.pointerId === event.pointerId) this.sheetDrag = null
  }

  private setSheet(open: boolean): void {
    if (this.sheetOpen === open) return
    this.sheetOpen = open
    if (!open) this.sheetDrag = null
    this.applySheet()
  }

  private get isMobile(): boolean {
    return this.mobileQuery?.matches ?? false
  }

  private applySheet(): void {
    const mobile = this.isMobile
    if (mobile) {
      this.element.dataset['sheet'] = this.sheetOpen ? 'open' : 'closed'
      setAttr(this.console, 'role', 'dialog')
      setAttr(this.console, 'aria-modal', 'true')
      setAttr(this.console, 'aria-labelledby', 'hud-sheet-title')
    } else {
      delete this.element.dataset['sheet']
      this.console.removeAttribute('role')
      this.console.removeAttribute('aria-modal')
      this.console.removeAttribute('aria-labelledby')
    }
    // Fora da tela ⇒ fora da ordem de tabulação.
    this.console.toggleAttribute('inert', this.chromeVisible ? mobile && !this.sheetOpen : true)
    setAttr(this.sheetToggle, 'aria-expanded', this.sheetOpen ? 'true' : 'false')
  }

  private readonly onBreakpointChange = (): void => {
    if (this.disposed) return
    this.applySheet()
  }

  setChromeVisible(visible: boolean): void {
    this.chromeVisible = visible
    if (visible) delete this.element.dataset['chrome']
    else this.element.dataset['chrome'] = 'hidden'
    this.sheetToggle.toggleAttribute('inert', !visible)
    this.applySheet()
  }

  // ── Teclado ─────────────────────────────────────────────────────────────────

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || event.defaultPrevented || event.repeat) return

    if (event.key === 'Escape' && this.sheetOpen && this.isMobile) {
      event.preventDefault()
      this.onSheetClose()
      return
    }
    if (!event.altKey || event.ctrlKey || event.metaKey) return

    const handled = ((): boolean => {
      switch (event.code) {
        case 'KeyL':
          this.togglePower()
          return true
        case 'KeyA':
          this.toggleSlot('A')
          return true
        case 'KeyB':
          this.toggleSlot('B')
          return true
        case 'KeyR':
          this.onResetClick()
          return true
        case 'KeyV':
          this.onResetViewClick()
          return true
        case 'KeyW':
          this.onWireframeClick()
          return true
        case 'KeyX':
          this.onXrayClick()
          return true
        case 'KeyG':
          this.onAutoRotateClick()
          return true
        case 'KeyH':
          this.setChromeVisible(!this.chromeVisible)
          return true
        default:
          return false
      }
    })()

    if (!handled) return
    event.preventDefault()
    event.stopPropagation()
  }

  private toggleSlot(slot: SlotId): void {
    const occupied = (slot === 'A' ? this.state.slotA : this.state.slotB).cartridge !== null
    if (occupied) this.ejectCartridge(slot)
    else this.insertCartridge(slot)
  }

  // ── Estado ──────────────────────────────────────────────────────────────────

  private readonly onExternalState = (incoming: unknown): void => {
    this.push(incoming)
  }

  private readonly onDomStateEvent = (event: unknown): void => {
    if (event instanceof CustomEvent) this.push(event.detail)
    else if (this.bridge !== null) {
      for (const name of ACTIONS.getState) {
        const fn = methodOf(this.bridge, name)
        if (!fn) continue
        try {
          this.push(fn.call(this.bridge))
        } catch (error) {
          console.error(`[HUD] "${name}" lançou:`, error)
        }
        return
      }
    }
  }

  private readonly onBridgeAnnounced = (event: Event): void => {
    if (this.disposed || this.bridge !== null) return
    const detail = event instanceof CustomEvent ? (event.detail as unknown) : null
    if (looksLikeInteractions(detail)) this.attach(detail)
    else this.bind(window.__msxInteractions)
  }

  private readonly onStateAnnounced = (event: Event): void => {
    if (event instanceof CustomEvent) this.push(event.detail)
  }

  push(incoming: unknown): void {
    if (this.disposed) return
    const next = mergeState(this.state, incoming)
    if (next === this.state) return
    this.state = next
    this.render()
  }

  private patch(partial: Partial<HudState>): void {
    this.state = { ...this.state, ...partial }
    this.render()
  }

  getState(): HudState {
    return this.state
  }

  private populateCatalogue(): void {
    if (this.catalogue.length === 0) return
    for (const slot of ['A', 'B'] as const) {
      const select = this.slotControls[slot].select
      select.textContent = ''
      for (const cartridge of this.catalogue) {
        const option = el('option', undefined, cartridge.name)
        option.value = cartridge.id
        select.appendChild(option)
      }
      select.hidden = false
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  private powerLabel(): string {
    const { on, warmth } = this.state.power
    if (!on) return TXT.powerOff
    if (warmth < 0.995) return `${TXT.powerWarming} · ${Math.round(warmth * 100)}%`
    return TXT.powerOn
  }

  private displayLabel(): string {
    if (this.state.displayMode !== null) return this.state.displayMode
    if (this.state.xray) return TXT.modeXray
    if (this.state.wireframe) return TXT.modeWireframe
    return TXT.modeSolid
  }

  private emulatorLabel(): string {
    switch (this.state.emulator) {
      case 'webmsx':
        return TXT.emulatorWebmsx
      case 'procedural':
        return TXT.emulatorProcedural
      default:
        return TXT.emulatorIdle
    }
  }

  private render(): void {
    if (this.disposed) return
    const { power, slotA, slotB } = this.state

    setText(this.powerValue, this.powerLabel())
    setAttr(this.powerLamp, 'data-lit', power.on ? '1' : '0')
    const powerCell = this.powerValue.parentElement
    if (powerCell) setAttr(powerCell, 'data-tone', power.on ? 'on' : 'off')

    const focused = document.activeElement
    for (const slot of ['A', 'B'] as const) {
      const cartridge = (slot === 'A' ? slotA : slotB).cartridge
      const cell = this.slotValues[slot]
      setText(cell, cartridge?.name ?? TXT.emptySlot)
      setAttr(cell, 'data-tone', cartridge === null ? 'off' : 'live')
      const controls = this.slotControls[slot]
      // Ejetar só faz sentido com cartucho dentro; trocar exige ejetar antes.
      controls.eject.disabled = cartridge === null
      controls.insert.disabled = cartridge !== null
      controls.select.disabled = cartridge !== null
      // Desabilitar o botão sob o foco jogaria o foco no <body> e quebraria a
      // navegação por teclado: passamos o foco para o par que acabou de habilitar.
      if (focused === controls.insert && controls.insert.disabled) controls.eject.focus()
      else if (focused === controls.eject && controls.eject.disabled) controls.insert.focus()
    }

    setText(this.displayValue, this.displayLabel())
    setAttr(this.displayValue, 'data-tone', 'live')
    setText(this.emulatorValue, this.emulatorLabel())
    setAttr(this.emulatorValue, 'data-tone', this.state.emulator === null ? 'off' : 'live')

    const powerLabelNode = this.powerButton.firstElementChild
    if (powerLabelNode) setText(powerLabelNode, power.on ? TXT.turnOff : TXT.turnOn)
    setAttr(this.powerButton, 'data-on', power.on ? '1' : '0')
    setAttr(
      this.powerButton,
      'aria-label',
      power.on ? `${TXT.turnOff} o computador` : `${TXT.turnOn} o computador`,
    )

    setAttr(this.wireframeButton, 'aria-pressed', this.state.wireframe ? 'true' : 'false')
    setAttr(this.xrayButton, 'aria-pressed', this.state.xray ? 'true' : 'false')
    setAttr(this.autoRotateButton, 'aria-pressed', this.state.autoRotate ? 'true' : 'false')

    if (this.state.note === null) {
      this.noteNode.hidden = true
      setText(this.noteNode, '')
    } else {
      this.noteNode.hidden = false
      setText(this.noteNode, this.state.note)
      setAttr(this.noteNode, 'data-tone', this.state.noteTone)
    }

    setText(this.sheetToggleState, this.powerLabel())
    setAttr(
      this.sheetToggle,
      'aria-label',
      `${TXT.sheetAriaOpen} — ${this.powerLabel().toLowerCase()}`,
    )

    this.announce()
  }

  /**
   * Região viva com granularidade grossa: o estado de energia é reduzido a
   * ligado/desligado/aquecendo (sem a porcentagem, que muda a cada quadro).
   */
  private announce(): void {
    const { power, slotA, slotB } = this.state
    const coarsePower = !power.on ? TXT.powerOff : power.warmth < 0.995 ? TXT.powerWarming : TXT.powerOn
    const summary = [
      `${TXT.readoutPower}: ${coarsePower}.`,
      `${TXT.readoutSlotA}: ${slotA.cartridge?.name ?? TXT.emptySlot}.`,
      `${TXT.readoutSlotB}: ${slotB.cartridge?.name ?? TXT.emptySlot}.`,
      `${TXT.readoutDisplay}: ${this.displayLabel()}.`,
    ].join(' ')
    if (summary === this.lastAnnounced) return
    this.lastAnnounced = summary
    this.announcer.textContent = summary
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of this.timers) window.clearTimeout(id)
    this.timers.length = 0
    try {
      this.unsubscribe?.()
    } catch (error) {
      console.error('[HUD] falha ao cancelar a assinatura:', error)
    }
    this.unsubscribe = null
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    window.removeEventListener('pointerup', this.onSheetDragEnd)
    window.removeEventListener('pointercancel', this.onSheetDragCancel)
    window.removeEventListener('msx:interactions', this.onBridgeAnnounced)
    window.removeEventListener('msx:state', this.onStateAnnounced)
    this.mobileQuery?.removeEventListener('change', this.onBreakpointChange)
    this.element.remove()
    if (window.__msxHud === this) delete window.__msxHud
  }
}

// ─── Fábrica ─────────────────────────────────────────────────────────────────────

let instance: Hud | null = null

/**
 * Monta o HUD e devolve o handle.
 *
 * @param interactions Camada de interação ({@link HudInteractions}), ou o `AppContext`
 *   do engine — de onde o HUD extrai o rig de câmera e procura a ponte. Pode ser
 *   omitido: a ponte é religada quando aparecer.
 *
 * Idempotente: chamar duas vezes devolve o mesmo HUD, nunca um segundo overlay.
 */
export function createHud(interactions?: unknown): HudHandle {
  if (instance !== null) return instance
  const hud = new Hud(interactions ?? null)
  instance = hud
  window.__msxHud = hud
  return hud
}

/** Desmonta o HUD atual, se houver. */
export function destroyHud(): void {
  instance?.dispose()
  instance = null
}
