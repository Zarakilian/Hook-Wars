import '@fontsource/lilita-one';
import '@fontsource-variable/nunito';
import './ui/styles.css';
import { App } from './app.ts';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
new App(canvas, ui);
