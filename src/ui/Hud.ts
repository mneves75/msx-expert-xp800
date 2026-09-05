import './hud.css'
import type { InteractionsHandle, InteractionsState, SlotId } from '../interaction/Interactions'

/** Native DOM controls over one injected interaction module. */
export interface HudHandle {
  readonly element: HTMLElement
  getState(): InteractionsState
  setChromeVisible(visible: boolean): void
  dispose(): void
}

declare global {
  interface Window {
    /** Capture and debug handle. */
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
} as const

/** Rótulo do modificador conforme a plataforma. */
function altLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Mac|iPhone|iPad|iPod/i.test(ua) ? '⌥' : 'Alt'
}

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

// ─── Implementação ───────────────────────────────────────────────────────────────

interface SlotControls {
  readonly select: HTMLSelectElement
  readonly insert: HTMLButtonElement
  readonly eject: HTMLButtonElement
}

class Hud implements HudHandle {
  readonly element: HTMLElement

  private state: InteractionsState
  private lastAnnounced = ''
  private readonly unsubscribe: () => void
  private disposed = false
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

  constructor(private readonly interactions: InteractionsHandle) {
    this.state = interactions.getState()
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
        this.showFileError(TXT.loadRomTooBig)
        return
      }
      file
        .arrayBuffer()
        .then((buffer) => {
          if (!this.disposed) this.interactions.loadLocalRom(new Uint8Array(buffer), file.name)
        })
        .catch(() => {
          this.showFileError(TXT.loadRomReadError)
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
    this.mobileQuery?.addEventListener('change', this.onBreakpointChange)

    document.body.appendChild(root)

    this.populateCatalogue()
    this.applySheet()
    this.unsubscribe = interactions.subscribe((state) => {
      this.state = state
      this.render()
    })
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

  // ── Actions ───────────────────────────────────────────────────────────────

  private readonly onPowerClick = (): void => this.interactions.togglePower()
  private readonly onResetClick = (): void => this.interactions.reset()
  private readonly onResetViewClick = (): void => this.interactions.resetView()
  private readonly onWireframeClick = (): void => this.interactions.toggleWireframe()
  private readonly onXrayClick = (): void => this.interactions.toggleXRay()
  private readonly onAutoRotateClick = (): void => this.interactions.toggleAutoRotate()

  private insertCartridge(slot: SlotId): void {
    this.interactions.insertCartridge(slot, this.slotControls[slot].select.value || undefined)
  }

  private ejectCartridge(slot: SlotId): void {
    this.interactions.ejectCartridge(slot)
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
    if (this.disposed || event.defaultPrevented) return

    if (event.key === 'Tab' && this.sheetOpen && this.isMobile && this.chromeVisible) {
      const controls = Array.from(this.console.querySelectorAll<HTMLElement>('button, select, input, [href], [tabindex]'))
        .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled, [hidden]'))
      const first = controls[0]
      const last = controls[controls.length - 1]
      const edge = event.shiftKey ? first : last
      if (document.activeElement === edge || !this.console.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      }
      return
    }
    if (event.repeat) return

    if (event.key === 'Escape' && this.sheetOpen && this.isMobile) {
      event.preventDefault()
      this.onSheetClose()
      return
    }
    if (!event.altKey || event.ctrlKey || event.metaKey) return

    const handled = ((): boolean => {
      switch (event.code) {
        case 'KeyL':
          this.onPowerClick()
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
    const occupied = (slot === 'A' ? this.state.slotA : this.state.slotB) !== null
    if (occupied) this.ejectCartridge(slot)
    else this.insertCartridge(slot)
  }

  // ── Estado ──────────────────────────────────────────────────────────────────

  private showFileError(message: string): void {
    if (this.disposed) return
    this.state = { ...this.state, note: message, error: message }
    this.render()
  }

  getState(): InteractionsState {
    return this.state
  }

  private populateCatalogue(): void {
    if (this.interactions.cartridges.length === 0) return
    for (const slot of ['A', 'B'] as const) {
      const select = this.slotControls[slot].select
      select.textContent = ''
      for (const cartridge of this.interactions.cartridges) {
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
      const cartridge = slot === 'A' ? slotA : slotB
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
      setAttr(this.noteNode, 'data-tone', this.state.error === undefined ? 'info' : 'alert')
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
      `${TXT.readoutSlotA}: ${slotA?.name ?? TXT.emptySlot}.`,
      `${TXT.readoutSlotB}: ${slotB?.name ?? TXT.emptySlot}.`,
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
    try {
      this.unsubscribe()
    } catch (error) {
      console.error('[HUD] falha ao cancelar a assinatura:', error)
    }
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    window.removeEventListener('pointerup', this.onSheetDragEnd)
    window.removeEventListener('pointercancel', this.onSheetDragCancel)
    this.mobileQuery?.removeEventListener('change', this.onBreakpointChange)
    this.element.remove()
    if (window.__msxHud === this) delete window.__msxHud
  }
}

/** Bootstrap owns this handle and disposes it before its interaction module. */
export function createHud(interactions: InteractionsHandle): HudHandle {
  const hud = new Hud(interactions)
  window.__msxHud = hud
  return hud
}
