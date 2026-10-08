// App controller: owns state, the engine, audio, the online connection and the running match.
import type { Profile, ServerMsg } from '../shared/protocol.ts';
import type { ItemId, MatchConfig, Team, UpgradeStat } from '../shared/types.ts';
import { createAudio } from './audio/audio.ts';
import { createEconomy } from './economy/index.ts';
import type { EconomyClient } from './economy/types.ts';
import { matchPearls } from '../shared/cosmetics.ts';
import { SOLO_PEARL_RATE } from '../shared/economy.ts';
import { GameClient } from './game/GameClient.ts';
import { Connection, defaultServerUrl, normaliseServerUrl } from './net/connection.ts';
import { LocalSession, OnlineSession, type MatchSession } from './net/session.ts';
import type { AudioSystem, Engine, Quality } from './render/contracts.ts';
import { createEngine } from './render/engine.ts';
import { autoQuality, loadProfile, loadSettings, saveProfile, saveSettings, type Settings } from './settings.ts';
import type { AppActions, AppState, ChatLine, Screen, UI } from './ui/types.ts';
import { createUI } from './ui/ui.ts';

export class App {
  private state: AppState;
  private readonly ui: UI;
  private readonly engine: Engine;
  private readonly audio: AudioSystem;
  private readonly canvas: HTMLCanvasElement;
  private conn: Connection | null = null;
  private session: MatchSession | null = null;
  private game: GameClient | null = null;
  private toastId = 0;
  private menuOpen = false;
  private readonly act: AppActions;
  readonly economy: EconomyClient;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    const settings = loadSettings();
    this.state = {
      screen: 'menu',
      profile: loadProfile(),
      settings,
      online: { status: 'idle', url: '', youId: -1, rooms: [] },
      room: null,
      match: null,
      chat: [],
      toast: null,
    };
    this.engine = createEngine(canvas, this.resolveQuality(settings.quality));
    this.audio = createAudio();
    this.audio.setVolumes(settings.master, settings.sfx, settings.music);
    this.act = this.actions();
    this.economy = createEconomy();
    this.ui = createUI(uiRoot, this.act, this.economy);
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.render();
    this.audio.setMusic('menu');
    requestAnimationFrame((t) => this.loop(t));
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) this.installDebugHook();
  }

  /** Dev only: drive frames from the console or automated checks, even when the tab is hidden. */
  private installDebugHook(): void {
    let fake = performance.now();
    (window as unknown as Record<string, unknown>).__hookwars = {
      app: this,
      advance: (ms: number, step = 16.7) => {
        for (let t = 0; t < ms; t += step) {
          fake = Math.max(fake + step, performance.now());
          this.frameAt(fake);
        }
        return this.game?.hudState ?? null;
      },
      state: () => this.state,
      game: () => this.game,
      actions: this.act,
      /** start a solo match with config overrides, e.g. solo({ mapId: 'coralcove', riverMode: 'tidal' }) */
      solo: (patch: Partial<MatchConfig> = {}, team: Team = 0) => {
        this.act.startSolo({ ...this.state.settings.soloConfig, ...patch }, team);
        return this.game !== null;
      },
      /** solo only: move your own unit, e.g. to inspect a spot */
      teleport: (x: number, z: number) => {
        const s = this.session;
        if (s instanceof LocalSession) {
          const u = s.sim.unitById.get(s.start.you);
          if (u) {
            u.x = x;
            u.z = z;
          }
        }
      },
      menu: () => this.act.leaveMatch(),
    };
  }

  private frameAt(now: number): void {
    if (this.game) this.game.frame(now);
    else {
      this.engine.update(1 / 60, now / 1000, 0, 0);
      this.engine.render();
    }
  }

  private resolveQuality(q: Quality | 'auto'): Quality {
    return q === 'auto' ? autoQuality() : q;
  }

  private resize(): void {
    this.engine.resize(window.innerWidth, window.innerHeight);
  }

  private loop(now: number): void {
    requestAnimationFrame((t) => this.loop(t));
    try {
      this.frameAt(now);
    } catch (err) {
      console.error('[frame]', err);
    }
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private render(): void {
    this.ui.render(this.state);
  }

  private toast(text: string, kind: 'info' | 'error' = 'info'): void {
    this.set({ toast: { text, kind, id: ++this.toastId } });
  }

  private addChat(line: ChatLine): void {
    const chat = [...this.state.chat, line].slice(-50);
    this.state = { ...this.state, chat };
    if (this.game) this.ui.hud.chat(line);
    else this.render();
  }

  // ------------------------------------------------------------------------------------------
  // Matches
  // ------------------------------------------------------------------------------------------

  private beginMatch(session: MatchSession): void {
    this.endGame();
    this.session = session;
    this.game = new GameClient(session, {
      engine: this.engine,
      audio: this.audio,
      hud: this.ui.hud,
      settings: this.state.settings,
      canvas: this.canvas,
      onEnd: (e) => {
        if (session.local) {
          // solo: Pearls go to the offline locker at a reduced rate (online, the server pays out)
          const me = e.players.find((p) => p.id === session.start.you);
          const row = e.rows.find((r) => r.i === session.start.you);
          if (me && row) this.economy.grantLocal(Math.round(matchPearls(e.winner === me.team, row.k, row.hh, row.sv) * SOLO_PEARL_RATE), 'solo match');
        }
        this.set({ match: { local: session.local, ended: e } });
        const g = this.game;
        this.ui.hud.showEnd(e, session.start.you, session.local);
        void g;
      },
      onEscape: () => this.toggleMenu(),
    });
    this.menuOpen = false;
    this.set({ screen: 'match', match: { local: session.local, ended: null } });
  }

  private toggleMenu(open?: boolean): void {
    this.menuOpen = open ?? !this.menuOpen;
    this.ui.hud.toggleMenu(this.menuOpen);
    if (this.session instanceof LocalSession) {
      this.session.setPaused(this.menuOpen);
      this.game?.setPaused(this.menuOpen);
    }
  }

  private endGame(): void {
    if (this.game) {
      this.game.dispose();
      this.game = null;
    }
    this.session = null;
    this.engine.setAtmosphere(null, null);
    this.audio.setMusic('menu');
  }

  // ------------------------------------------------------------------------------------------
  // Online
  // ------------------------------------------------------------------------------------------

  private onServer(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.set({ online: { ...this.state.online, status: 'connected', youId: m.id, serverName: m.serverName, motd: m.motd } });
        this.conn?.send({ t: 'listRooms' });
        break;
      case 'rooms':
        this.set({ online: { ...this.state.online, rooms: m.rooms } });
        break;
      case 'room': {
        const wasMatch = this.state.room?.phase === 'match';
        this.state = { ...this.state, room: m.room };
        if (m.room.phase === 'lobby' && wasMatch && this.game) {
          // server returned everyone to the lobby after the match
          this.endGame();
          this.set({ screen: 'lobby', match: null });
        } else if (!this.game) this.set({ screen: 'lobby' });
        else this.render();
        break;
      }
      case 'leftRoom':
        this.endGame();
        this.set({ room: null, screen: 'online', match: null, chat: [] });
        this.conn?.send({ t: 'listRooms' });
        break;
      case 'start':
        if (this.conn) this.beginMatch(new OnlineSession(this.conn, m.m));
        break;
      case 'players':
        if (this.session instanceof OnlineSession) this.session.receivePlayers(m.players);
        break;
      case 's':
        if (this.session instanceof OnlineSession) this.session.receiveSnapshot(m.s);
        break;
      case 'end':
        if (this.session instanceof OnlineSession) this.session.receiveEnd(m.e);
        break;
      case 'chat':
        this.addChat({ from: m.from, fromId: m.fromId, text: m.text, team: m.team, teamId: m.teamId, time: Date.now() });
        break;
      case 'error':
        this.toast(m.message, 'error');
        break;
      case 'account':
      case 'market':
      case 'walletChallenge':
      case 'usdcOrder':
      case 'reward':
      case 'econError':
        this.economy.receive(m);
        if (m.t === 'account' && m.a.loadouts[this.state.profile.family]) {
          // the server says what we may wear: keep the profile in step
          this.state = { ...this.state, profile: { ...this.state.profile, loadout: m.a.loadouts[this.state.profile.family] } };
          this.render();
        }
        if (m.t === 'reward') this.toast(`+${m.pearls} Pearls (${m.reason})`);
        break;
      default:
        break;
    }
  }

  private actions(): AppActions {
    const app = this;
    return {
      go(screen: Screen) {
        if (screen === 'match' && !app.game) return;
        if (app.game && screen !== 'match' && screen !== 'settings') return;
        app.set({ screen });
        if (screen === 'match') app.toggleMenu(true);
      },
      saveProfile(p: Profile) {
        saveProfile(p);
        app.conn?.send({ t: 'setProfile', profile: p });
        app.set({ profile: p });
      },
      saveSettings(s: Settings) {
        saveSettings(s);
        const prev = app.state.settings;
        if (s.quality !== prev.quality) app.engine.setQuality(app.resolveQuality(s.quality));
        app.audio.setVolumes(s.master, s.sfx, s.music);
        app.game?.setSettings(s);
        app.set({ settings: s });
      },
      startSolo(config: MatchConfig, team: Team) {
        app.audio.unlock();
        app.beginMatch(new LocalSession(config, app.state.profile, team));
      },
      connect(url: string) {
        const full = normaliseServerUrl(url);
        if (!full) {
          app.toast('That server address does not look right.', 'error');
          return;
        }
        app.conn?.close();
        const s = { ...app.state.settings, serverUrl: url.trim() };
        saveSettings(s);
        const serverKey = full === defaultServerUrl() && !url.trim() ? defaultServerUrl() : full;
        const conn = new Connection(serverKey, app.state.profile, app.economy.tokenFor(serverKey));
        app.economy.attachServer((m) => conn.send(m as Parameters<Connection['send']>[0]), serverKey);
        app.conn = conn;
        conn.onMessage = (m) => app.onServer(m);
        conn.onStatus = (st, reason) => {
          if (app.conn !== conn) return;
          if (st === 'closed') {
            app.economy.detachServer();
            const inMatch = !!app.game && !app.session?.local;
            if (inMatch) app.endGame();
            app.conn = null;
            app.set({ online: { ...app.state.online, status: 'error', error: reason }, room: null, screen: inMatch || app.state.screen === 'lobby' ? 'online' : app.state.screen, match: inMatch ? null : app.state.match });
          }
        };
        app.set({ settings: s, online: { ...app.state.online, status: 'connecting', url: full, error: undefined } });
      },
      disconnect() {
        app.economy.detachServer();
        app.conn?.close();
        app.conn = null;
        app.set({ online: { status: 'idle', url: '', youId: -1, rooms: [] }, room: null, screen: 'online' });
      },
      refreshRooms() {
        app.conn?.send({ t: 'listRooms' });
      },
      createRoom(name: string, isPrivate: boolean, config: MatchConfig) {
        app.conn?.send({ t: 'createRoom', name, isPrivate, config });
      },
      joinRoom(code: string) {
        const c = code.trim().toUpperCase();
        if (!/^[A-Z]{5}$/.test(c)) {
          app.toast('Room codes are 5 letters.', 'error');
          return;
        }
        app.conn?.send({ t: 'joinRoom', code: c });
      },
      quickPlay() {
        app.conn?.send({ t: 'quickPlay' });
      },
      leaveRoom() {
        app.conn?.send({ t: 'leaveRoom' });
      },
      setTeam(team: Team | -1) {
        app.conn?.send({ t: 'setTeam', team });
      },
      setConfig(config: MatchConfig) {
        app.conn?.send({ t: 'setConfig', config });
      },
      setReady(ready: boolean) {
        app.conn?.send({ t: 'ready', ready });
      },
      startMatch() {
        app.conn?.send({ t: 'start' });
      },
      sendChat(text: string, team: boolean) {
        const t = text.trim();
        if (!t) return;
        if (app.session?.local) {
          app.addChat({ from: app.state.profile.name, fromId: 1, text: t.slice(0, 120), team, teamId: 0, time: Date.now() });
          return;
        }
        app.conn?.send({ t: 'chat', text: t, team });
      },
      buy(item: ItemId) {
        app.session?.buy(item);
      },
      sell(slot: number) {
        app.session?.sell(slot);
      },
      upgrade(stat: UpgradeStat) {
        app.session?.upgrade(stat);
      },
      leaveMatch() {
        const local = app.session?.local ?? true;
        app.endGame();
        app.menuOpen = false;
        if (local) app.set({ screen: 'solo', match: null });
        else {
          const room = app.state.room;
          if (room && room.phase === 'match') app.conn?.send({ t: 'leaveRoom' });
          app.set({ screen: room && room.phase === 'lobby' ? 'lobby' : 'online', match: null });
        }
      },
      resume() {
        if (app.game) app.toggleMenu(false);
      },
      backToLobby() {
        if (!app.game || app.session?.local) return;
        app.endGame();
        app.menuOpen = false;
        app.set({ screen: app.state.room ? 'lobby' : 'online', match: null });
      },
      uiSound(kind) {
        app.audio.unlock();
        app.audio.play(kind === 'click' ? 'uiClick' : kind === 'hover' ? 'uiHover' : kind === 'open' ? 'uiOpen' : kind);
      },
    };
  }
}
