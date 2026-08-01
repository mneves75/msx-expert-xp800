/**
 * SUPER CÓSMICO — jogo autoral em Z80, gerado byte a byte.
 *
 * O cartucho vermelho da cena ("Super Cósmico", `romId: arcade-vermelho`) roda
 * este programa no WebMSX real. É um snake espacial completo: a sonda coleta
 * estrelas, a cauda cresce, bater na borda ou na própria cauda encerra a
 * partida. Setas do teclado (ou joystick MSX na porta 1) movem a sonda.
 *
 * Por que escrever um jogo em assembly aqui: o projeto não distribui ROM de
 * terceiros (invariante #1 — jogos comerciais da época seguem com copyright
 * ativo), então a única demonstração honesta de "usar o MSX" é código nosso
 * executando de verdade no Z80 emulado — input, VRAM, loop de jogo e colisão,
 * tudo real.
 *
 * Disciplina de montagem, para quem for mexer:
 *
 *  - Saltos NUNCA são contados à mão: o {@link Asm} resolve labels em dois
 *    passos (`jr`/`djnz` relativos com verificação de alcance, `jp`/`dw`
 *    absolutos). Conta manual de offset é exatamente o tipo de bug silencioso
 *    que um assembler de 40 linhas elimina.
 *  - Toda chamada de BIOS assume AF/BC/DE/HL destruídos — o estado do jogo
 *    vive na RAM (página 3) e é recarregado a cada uso. Mais lento e à prova
 *    de diferenças entre o BIOS documentado e o C-BIOS.
 *  - O C-BIOS não tem BASIC: o INIT do cartucho é dono da máquina e nunca
 *    retorna (mesmo contrato do `buildDemoRom`).
 *
 * Entradas de BIOS usadas (MSX1 padrão, implementadas pelo C-BIOS):
 *   INIT32 0x006F  SCREEN 1 (32 col; name table 0x1800)
 *   CHGET  0x009F  espera tecla   CHPUT 0x00A2  imprime
 *   RDVRM  0x004A  lê VRAM        WRTVRM 0x004D escreve VRAM
 *   FILVRM 0x0056  preenche VRAM  LDIRVM 0x005C copia RAM→VRAM
 *   GTSTCK 0x00D5  direção (A=0 cursores, A=1 joystick 1)
 *   BEEP   0x00C0  bip do sistema
 */

// ─── Mini-assembler two-pass ─────────────────────────────────────────────────────

class Asm {
  private readonly bytes: number[] = []
  private readonly labels = new Map<string, number>()
  private readonly fixups: Array<{ at: number; label: string; kind: 'rel8' | 'abs16' }> = []

  constructor(private readonly origin: number) {}

  get pc(): number {
    return this.origin + this.bytes.length
  }

  /** Emite bytes crus (opcodes e imediatos já conhecidos). */
  db(...values: number[]): void {
    for (const value of values) this.bytes.push(value & 0xff)
  }

  label(name: string): void {
    if (this.labels.has(name)) throw new Error(`Asm: label duplicado "${name}"`)
    this.labels.set(name, this.pc)
  }

  /** Byte de deslocamento relativo a resolver — para `jr cc` e `djnz`. */
  rel8(label: string): void {
    this.fixups.push({ at: this.bytes.length, label, kind: 'rel8' })
    this.db(0)
  }

  /** `jr <label>` / `jr cc,<label>`: opcode do salto + deslocamento resolvido. */
  jr(opcode: number, label: string): void {
    this.db(opcode)
    this.rel8(label)
  }

  /** Endereço absoluto de 16 bits a resolver (`jp`, `call`, `ld rr,nn`, `dw`). */
  word(label: string): void {
    this.fixups.push({ at: this.bytes.length, label, kind: 'abs16' })
    this.db(0, 0)
  }

  resolve(): Uint8Array {
    for (const fixup of this.fixups) {
      const target = this.labels.get(fixup.label)
      if (target === undefined) throw new Error(`Asm: label indefinido "${fixup.label}"`)
      if (fixup.kind === 'abs16') {
        this.bytes[fixup.at] = target & 0xff
        this.bytes[fixup.at + 1] = (target >> 8) & 0xff
      } else {
        // O deslocamento do `jr`/`djnz` é relativo à instrução seguinte.
        const delta = target - (this.origin + fixup.at + 1)
        if (delta < -128 || delta > 127) {
          throw new Error(`Asm: salto relativo para "${fixup.label}" fora de alcance (${delta})`)
        }
        this.bytes[fixup.at] = delta & 0xff
      }
    }
    return Uint8Array.from(this.bytes)
  }
}

// ─── Constantes ──────────────────────────────────────────────────────────────────

// BIOS
const RDVRM = 0x004a
const WRTVRM = 0x004d
const FILVRM = 0x0056
const LDIRVM = 0x005c
const INIT32 = 0x006f
const CHGET = 0x009f
const CHPUT = 0x00a2
const BEEP = 0x00c0
const GTSTCK = 0x00d5
const KILBUF = 0x0156

// Área de sistema (workspace do BIOS)
const FORCLR = 0xf3e9
const BAKCLR = 0xf3ea
const BDRCLR = 0xf3eb

// Name table do SCREEN 1 e geometria do campo
const NAME = 0x1800
const COLS = 32
/** Linha 0 é o placar; o campo jogável fica entre as bordas (linhas 1 e 23). */
const SCORE_ROW_ADDR = NAME
const TOP_WALL = NAME + COLS
const BOTTOM_WALL = NAME + 23 * COLS
const START_ADDR = NAME + 12 * COLS + 16
/** Colunas dos dois dígitos do placar na linha 0 — casadas com `SCORE_LINE`. */
const SCORE_DIGITS_COL = 26

// Tiles (fonte padrão do MSX)
const CH_SPACE = 0x20
const CH_WALL = 0x23 // '#'
const CH_BODY = 0x6f // 'o'
const CH_HEAD = 0x40 // '@'
const CH_STAR = 0x2a // '*'

// RAM do jogo (página 3, longe da área de sistema em 0xF380+)
const QUEUE = 0xe000 // 128 entradas × 2 bytes (endereços VRAM do corpo)
const QUEUE_MASK = 0x7f
const VAR_HEAD_IDX = 0xe100
const VAR_TAIL_IDX = 0xe101
const VAR_DIR = 0xe102 // 0=cima 1=direita 2=baixo 3=esquerda
const VAR_PENDING = 0xe103
const VAR_SCORE = 0xe104
const VAR_RNG = 0xe105
const VAR_HEAD_ADDR = 0xe106 // word: endereço VRAM da cabeça
const VAR_NEW_ADDR = 0xe108 // word: endereço candidato do próximo passo
const LINE_BUF = 0xe110 // 32 bytes: staging de linha montada em RAM

/** Passos por segundo ≈ 60 / DELAY_FRAMES. */
const DELAY_FRAMES = 7
/**
 * Teto do placar. Também é o freio da cauda: no teto o passo com estrela volta a
 * recolher a cauda, então o comprimento máximo é 1 + SCORE_CAP = 100 — com folga
 * dentro das 128 entradas da fila circular.
 */
const SCORE_CAP = 99

const ORIGIN = 0x4000
const INIT = 0x4010

// As duas linhas têm exatamente 32 colunas; os dígitos "00" ficam nas colunas
// SCORE_DIGITS_COL/+1 — verificado por asserção no build, não por fé.
const SCORE_LINE = ' SUPER COSMICO     PONTOS 00    '
const GAMEOVER_LINE = ' FIM DE JOGO ---- PONTOS: 00    '

// ─── Helpers de emissão ──────────────────────────────────────────────────────────

/** `ld a,n : ld (addr),a` */
function ldMemA(a: Asm, addr: number, value: number): void {
  a.db(0x3e, value) // ld a,n
  a.db(0x32, addr & 0xff, (addr >> 8) & 0xff) // ld (addr),a
}

/** `ld a,(addr)` */
function ldAMem(a: Asm, addr: number): void {
  a.db(0x3a, addr & 0xff, (addr >> 8) & 0xff)
}

/** `ld hl,(addr)` */
function ldHlMem(a: Asm, addr: number): void {
  a.db(0x2a, addr & 0xff, (addr >> 8) & 0xff)
}

/** `ld (addr),hl` */
function stHlMem(a: Asm, addr: number): void {
  a.db(0x22, addr & 0xff, (addr >> 8) & 0xff)
}

/** `ld hl,nn` imediato. */
function ldHlImm(a: Asm, value: number): void {
  a.db(0x21, value & 0xff, (value >> 8) & 0xff)
}

/** `ld bc,nn` imediato. */
function ldBcImm(a: Asm, value: number): void {
  a.db(0x01, value & 0xff, (value >> 8) & 0xff)
}

/** `ld de,nn` imediato. */
function ldDeImm(a: Asm, value: number): void {
  a.db(0x11, value & 0xff, (value >> 8) & 0xff)
}

/** `call nn` para endereço fixo (BIOS). */
function call(a: Asm, addr: number): void {
  a.db(0xcd, addr & 0xff, (addr >> 8) & 0xff)
}

/** `call <label>` interno. */
function callLabel(a: Asm, label: string): void {
  a.db(0xcd)
  a.word(label)
}

/** `jp <label>` */
function jp(a: Asm, label: string): void {
  a.db(0xc3)
  a.word(label)
}

/** `jp z,<label>` */
function jpZ(a: Asm, label: string): void {
  a.db(0xca)
  a.word(label)
}

/** `jp nz,<label>` */
function jpNz(a: Asm, label: string): void {
  a.db(0xc2)
  a.word(label)
}

function pushText(a: Asm, text: string): void {
  for (const ch of text) a.db(ch.charCodeAt(0) & 0x7f)
}

// Condições do `jr cc`, para legibilidade nos call sites.
const JR = 0x18
const JR_NZ = 0x20
const JR_Z = 0x28
const JR_NC = 0x30
const JR_C = 0x38

// ─── A ROM ───────────────────────────────────────────────────────────────────────

let cachedRom: Uint8Array | null = null

/** Monta (uma vez) o cartucho de 16 KB do Super Cósmico. */
export function buildSuperCosmicoRom(): Uint8Array {
  if (cachedRom !== null) return cachedRom

  for (const line of [SCORE_LINE, GAMEOVER_LINE]) {
    if (line.length !== COLS) throw new Error('SuperCosmico: linha de HUD fora de 32 colunas.')
    if (line.slice(SCORE_DIGITS_COL, SCORE_DIGITS_COL + 2) !== '00') {
      throw new Error('SuperCosmico: dígitos do placar fora das colunas esperadas.')
    }
  }

  const a = new Asm(INIT)

  // ── INIT: cores, modo de tela, splash ──────────────────────────────────────
  a.label('init')
  ldMemA(a, FORCLR, 15) // branco
  ldMemA(a, BAKCLR, 1) // preto — espaço
  ldMemA(a, BDRCLR, 1)
  call(a, INIT32)

  // Splash via CHPUT (o INIT32 deixa o cursor no topo).
  a.db(0x21) // ld hl,splash-text
  a.word('splash-text')
  callLabel(a, 'print')
  // KILBUF antes de TODO CHGET: as setas do jogo (e o repeat de uma tecla
  // segurada) também entram no KEYBUF como caracteres — sem o flush, o CHGET
  // consome lixo bufferizado e a espera "qualquer tecla" nem acontece.
  call(a, KILBUF)
  call(a, CHGET) // qualquer tecla começa

  // ── GAME-INIT: estado zerado, campo desenhado ──────────────────────────────
  a.label('game-init')
  // Limpa o name table inteiro com espaços. FILVRM: HL=início, BC=tamanho, A=byte.
  ldHlImm(a, NAME)
  ldBcImm(a, 768)
  a.db(0x3e, CH_SPACE)
  call(a, FILVRM)

  ldMemA(a, VAR_SCORE, 0)
  ldMemA(a, VAR_DIR, 1) // começa indo para a direita
  ldMemA(a, VAR_PENDING, 1)
  ldMemA(a, VAR_HEAD_IDX, 0)
  ldMemA(a, VAR_TAIL_IDX, 0)
  ldHlImm(a, START_ADDR)
  stHlMem(a, VAR_HEAD_ADDR)

  // Bordas horizontais.
  ldHlImm(a, TOP_WALL)
  ldBcImm(a, COLS)
  a.db(0x3e, CH_WALL)
  call(a, FILVRM)
  ldHlImm(a, BOTTOM_WALL)
  ldBcImm(a, COLS)
  a.db(0x3e, CH_WALL)
  call(a, FILVRM)

  // Colunas 0 e 31, linhas 2..22 — HL caminha de 32 em 32.
  ldHlImm(a, TOP_WALL + COLS)
  a.db(0x06, 21) // ld b,21
  a.label('side-walls')
  a.db(0xc5) // push bc
  a.db(0xe5) // push hl
  a.db(0x3e, CH_WALL)
  call(a, WRTVRM) // parede na coluna 0
  a.db(0xe1) // pop hl
  a.db(0xe5) // push hl
  ldDeImm(a, COLS - 1)
  a.db(0x19) // add hl,de
  a.db(0x3e, CH_WALL)
  call(a, WRTVRM) // parede na coluna 31
  a.db(0xe1) // pop hl
  ldDeImm(a, COLS)
  a.db(0x19) // add hl,de
  a.db(0xc1) // pop bc
  a.db(0x10) // djnz side-walls
  a.rel8('side-walls')

  // Linha do placar (com "00" já impresso), cabeça inicial e primeira estrela.
  a.db(0x21) // ld hl,score-line (ROM)
  a.word('score-line')
  ldDeImm(a, SCORE_ROW_ADDR)
  ldBcImm(a, COLS)
  call(a, LDIRVM)

  ldHlMem(a, VAR_HEAD_ADDR)
  a.db(0x3e, CH_HEAD)
  call(a, WRTVRM)
  callLabel(a, 'queue-push-head') // fila nasce com só a cabeça
  callLabel(a, 'place-star')

  // ── MAIN-TICK ──────────────────────────────────────────────────────────────
  a.label('main-tick')
  a.db(0x06, DELAY_FRAMES) // ld b,DELAY_FRAMES
  a.label('delay-loop')
  a.db(0xc5) // push bc
  a.db(0xfb) // ei
  a.db(0x76) // halt — sincroniza no VBLANK; input é sondado a cada quadro
  callLabel(a, 'poll-dir')
  a.db(0xc1) // pop bc
  a.db(0x10) // djnz delay-loop
  a.rel8('delay-loop')

  // Direção efetiva: a pendente vale, salvo se for o oposto exato da atual
  // (codificação 0..3 faz do XOR 2 o oposto: cima↔baixo, direita↔esquerda).
  ldAMem(a, VAR_DIR)
  a.db(0xee, 0x02) // xor 2
  a.db(0x47) // ld b,a
  ldAMem(a, VAR_PENDING)
  a.db(0xb8) // cp b
  a.jr(JR_Z, 'dir-kept') // reverso: mantém a atual
  a.db(0x32, VAR_DIR & 0xff, VAR_DIR >> 8) // ld (DIR),a
  a.label('dir-kept')

  // NEW = HEAD + DIRTAB[DIR]
  ldAMem(a, VAR_DIR)
  a.db(0x87) // add a,a — tabela de words
  a.db(0x5f) // ld e,a
  a.db(0x16, 0x00) // ld d,0
  a.db(0x21) // ld hl,dirtab
  a.word('dirtab')
  a.db(0x19) // add hl,de
  a.db(0x5e) // ld e,(hl)
  a.db(0x23) // inc hl
  a.db(0x56) // ld d,(hl)
  ldHlMem(a, VAR_HEAD_ADDR)
  a.db(0x19) // add hl,de
  stHlMem(a, VAR_NEW_ADDR)

  // O que há no destino?
  call(a, RDVRM) // A = tile em (HL)
  a.db(0xfe, CH_SPACE)
  jpZ(a, 'move-empty')
  a.db(0xfe, CH_STAR)
  jpZ(a, 'eat-star')
  jp(a, 'game-over')

  // ── Passo em célula vazia: avança e recolhe a cauda ────────────────────────
  a.label('move-empty')
  callLabel(a, 'advance-head')
  callLabel(a, 'pop-tail')
  jp(a, 'main-tick')

  // ── Estrela: avança, pontua, repõe; no teto a cauda volta a ser recolhida ──
  a.label('eat-star')
  callLabel(a, 'advance-head')
  ldAMem(a, VAR_SCORE)
  a.db(0xfe, SCORE_CAP)
  a.jr(JR_NC, 'eat-capped')
  a.db(0x3c) // inc a
  a.db(0x32, VAR_SCORE & 0xff, VAR_SCORE >> 8)
  callLabel(a, 'draw-score')
  a.jr(JR, 'eat-common')
  a.label('eat-capped')
  callLabel(a, 'pop-tail') // sem crescer: a fila de 128 nunca satura
  a.label('eat-common')
  call(a, BEEP)
  callLabel(a, 'place-star')
  jp(a, 'main-tick')

  // ── Fim de jogo ────────────────────────────────────────────────────────────
  a.label('game-over')
  call(a, BEEP)
  // Copia o template da ROM para a RAM, carimba os dígitos e sobe na linha 11.
  a.db(0x21) // ld hl,gameover-line (ROM)
  a.word('gameover-line')
  ldDeImm(a, LINE_BUF)
  ldBcImm(a, COLS)
  a.db(0xed, 0xb0) // ldir
  callLabel(a, 'score-digits') // D/E = dezena/unidade em ASCII
  ldHlImm(a, LINE_BUF + SCORE_DIGITS_COL)
  a.db(0x72) // ld (hl),d
  a.db(0x23) // inc hl
  a.db(0x73) // ld (hl),e
  ldHlImm(a, LINE_BUF)
  ldDeImm(a, NAME + 11 * COLS)
  ldBcImm(a, COLS)
  call(a, LDIRVM)
  // Morrer com a seta ainda PRESSIONADA é o caso comum — e o auto-repeat da BIOS
  // reenfileira caracteres DEPOIS de um KILBUF isolado, pulando o placar. A ordem
  // certa: esperar o direcional (cursores e joystick) ser solto, só então limpar
  // o buffer e esperar uma tecla nova de verdade.
  a.label('go-wait-release')
  a.db(0xfb) // ei
  a.db(0x76) // halt
  a.db(0xaf) // xor a — cursores
  call(a, GTSTCK)
  a.db(0xb7) // or a
  a.jr(JR_NZ, 'go-wait-release')
  a.db(0x3e, 0x01) // ld a,1 — joystick 1
  call(a, GTSTCK)
  a.db(0xb7) // or a
  a.jr(JR_NZ, 'go-wait-release')
  call(a, KILBUF) // agora sim: buffer limpo com tudo solto
  call(a, CHGET) // qualquer tecla…
  jp(a, 'game-init') // …reinicia

  // ── Sub-rotinas ────────────────────────────────────────────────────────────

  // print: CHPUT até NUL (HL = texto).
  a.label('print')
  a.db(0x7e) // ld a,(hl)
  a.db(0xb7) // or a
  a.db(0xc8) // ret z
  a.db(0xe5) // push hl
  call(a, CHPUT)
  a.db(0xe1) // pop hl
  a.db(0x23) // inc hl
  a.jr(JR, 'print')

  // poll-dir: GTSTCK dos cursores (0) e do joystick 1; cardinal vira PENDING.
  a.label('poll-dir')
  a.db(0xaf) // xor a — cursores do teclado
  call(a, GTSTCK)
  a.db(0xb7) // or a
  a.jr(JR_NZ, 'poll-map')
  a.db(0x3e, 0x01) // ld a,1 — joystick na porta 1
  call(a, GTSTCK)
  a.db(0xb7) // or a
  a.db(0xc8) // ret z — nada pressionado
  a.label('poll-map')
  // GTSTCK: 1=cima 3=direita 5=baixo 7=esquerda (ímpares são as cardinais).
  a.db(0x3d) // dec a — 1..8 → 0..7
  a.db(0xcb, 0x47) // bit 0,a — diagonais ficam de fora
  a.db(0xc0) // ret nz
  a.db(0xcb, 0x3f) // srl a — /2 → 0..3
  a.db(0x32, VAR_PENDING & 0xff, VAR_PENDING >> 8)
  a.db(0xc9) // ret

  // advance-head: cabeça velha vira corpo; NEW vira cabeça e entra na fila.
  a.label('advance-head')
  ldHlMem(a, VAR_HEAD_ADDR)
  a.db(0x3e, CH_BODY)
  call(a, WRTVRM)
  ldHlMem(a, VAR_NEW_ADDR)
  stHlMem(a, VAR_HEAD_ADDR)
  a.db(0x3e, CH_HEAD)
  call(a, WRTVRM)
  // cai direto em queue-push-head — o ret de lá encerra esta rotina também

  // queue-push-head: QUEUE[HEAD] = HEAD_ADDR; HEAD = (HEAD+1) & máscara
  a.label('queue-push-head')
  ldAMem(a, VAR_HEAD_IDX)
  callLabel(a, 'queue-entry-addr')
  a.db(0xeb) // ex de,hl — DE = &QUEUE[HEAD]
  ldHlMem(a, VAR_HEAD_ADDR)
  a.db(0xeb) // ex de,hl — HL = slot, DE = endereço da cabeça
  a.db(0x73) // ld (hl),e
  a.db(0x23) // inc hl
  a.db(0x72) // ld (hl),d
  ldAMem(a, VAR_HEAD_IDX)
  a.db(0x3c) // inc a
  a.db(0xe6, QUEUE_MASK)
  a.db(0x32, VAR_HEAD_IDX & 0xff, VAR_HEAD_IDX >> 8)
  a.db(0xc9) // ret

  // pop-tail: apaga a ponta da cauda e avança o índice.
  a.label('pop-tail')
  ldAMem(a, VAR_TAIL_IDX)
  callLabel(a, 'queue-entry-addr')
  a.db(0x5e) // ld e,(hl)
  a.db(0x23) // inc hl
  a.db(0x56) // ld d,(hl)
  a.db(0xeb) // ex de,hl — HL = endereço VRAM da ponta
  a.db(0x3e, CH_SPACE)
  call(a, WRTVRM)
  ldAMem(a, VAR_TAIL_IDX)
  a.db(0x3c) // inc a
  a.db(0xe6, QUEUE_MASK)
  a.db(0x32, VAR_TAIL_IDX & 0xff, VAR_TAIL_IDX >> 8)
  a.db(0xc9) // ret

  // queue-entry-addr: A = índice → HL = QUEUE + A×2
  a.label('queue-entry-addr')
  a.db(0x87) // add a,a
  a.db(0x6f) // ld l,a
  a.db(0x26, 0x00) // ld h,0
  ldDeImm(a, QUEUE)
  a.db(0x19) // add hl,de
  a.db(0xc9) // ret

  // score-digits: D/E = dezena/unidade em ASCII (placar ≤ 99).
  a.label('score-digits')
  ldAMem(a, VAR_SCORE)
  a.db(0x16, 0x30) // ld d,'0'
  a.label('digit-tens')
  a.db(0xfe, 0x0a) // cp 10
  a.jr(JR_C, 'digit-done')
  a.db(0xd6, 0x0a) // sub 10
  a.db(0x14) // inc d
  a.jr(JR, 'digit-tens')
  a.label('digit-done')
  a.db(0xc6, 0x30) // add a,'0'
  a.db(0x5f) // ld e,a
  a.db(0xc9) // ret

  // draw-score: carimba os dois dígitos na linha do placar.
  a.label('draw-score')
  callLabel(a, 'score-digits')
  a.db(0xd5) // push de
  ldHlImm(a, SCORE_ROW_ADDR + SCORE_DIGITS_COL)
  a.db(0x7a) // ld a,d
  call(a, WRTVRM)
  a.db(0xd1) // pop de
  ldHlImm(a, SCORE_ROW_ADDR + SCORE_DIGITS_COL + 1)
  a.db(0x7b) // ld a,e
  call(a, WRTVRM)
  a.db(0xc9) // ret

  // place-star: célula vazia pseudo-aleatória do campo recebe '*'.
  a.label('place-star')
  // rng = rot(rng) xor R + 1 — entropia mais que suficiente para posicionar.
  a.db(0xed, 0x5f) // ld a,r
  a.db(0x47) // ld b,a
  ldAMem(a, VAR_RNG)
  a.db(0x07) // rlca
  a.db(0xa8) // xor b
  a.db(0x3c) // inc a
  a.db(0x32, VAR_RNG & 0xff, VAR_RNG >> 8)
  // x = rng & 31, válido em 1..30
  a.db(0xe6, 0x1f) // and 31
  a.db(0xfe, 0x01) // cp 1
  a.jr(JR_C, 'place-star') // x = 0 → tenta de novo
  a.db(0xfe, 0x1f) // cp 31
  a.jr(JR_NC, 'place-star') // x = 31 → tenta de novo
  a.db(0x4f) // ld c,a — guarda x
  // y = ((rng >> 3) & 15) + 4 → 4..19, sempre dentro do campo (2..22)
  ldAMem(a, VAR_RNG)
  a.db(0x0f) // rrca ×3
  a.db(0x0f)
  a.db(0x0f)
  a.db(0xe6, 0x0f) // and 15
  a.db(0xc6, 0x04) // add a,4
  // HL = NAME + y×32 + x
  a.db(0x6f) // ld l,a
  a.db(0x26, 0x00) // ld h,0
  a.db(0x29) // add hl,hl ×5 → y×32
  a.db(0x29)
  a.db(0x29)
  a.db(0x29)
  a.db(0x29)
  a.db(0x06, 0x00) // ld b,0
  a.db(0x09) // add hl,bc — soma x
  ldDeImm(a, NAME)
  a.db(0x19) // add hl,de
  a.db(0xe5) // push hl
  call(a, RDVRM)
  a.db(0xe1) // pop hl
  a.db(0xfe, CH_SPACE)
  jpNz(a, 'place-star') // célula ocupada → sorteia outra
  a.db(0x3e, CH_STAR)
  call(a, WRTVRM)
  a.db(0xc9) // ret

  // ── Dados ──────────────────────────────────────────────────────────────────

  a.label('dirtab')
  // Deltas de endereço VRAM: cima, direita, baixo, esquerda.
  for (const delta of [-COLS, 1, COLS, -1]) {
    a.db(delta & 0xff, (delta >> 8) & 0xff)
  }

  a.label('score-line')
  pushText(a, SCORE_LINE)

  a.label('gameover-line')
  pushText(a, GAMEOVER_LINE)

  a.label('splash-text')
  for (const line of [
    'SUPER COSMICO',
    'GRADIENTE EXPERT XP-800',
    '',
    'COLETE AS ESTRELAS *',
    'SETAS OU JOYSTICK MOVEM',
    'NAO TOQUE NAS BORDAS NEM',
    'NA PROPRIA CAUDA',
    '',
    'QUALQUER TECLA COMECA',
  ]) {
    pushText(a, line)
    a.db(0x0d, 0x0a)
  }
  a.db(0x00)

  const code = a.resolve()
  const rom = new Uint8Array(0x4000)
  rom[0] = 0x41 // 'A'
  rom[1] = 0x42 // 'B'
  rom[2] = INIT & 0xff
  rom[3] = (INIT >> 8) & 0xff
  rom.set(code, INIT - ORIGIN)
  cachedRom = rom
  return rom
}
