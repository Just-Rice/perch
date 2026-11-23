// Pages of plain reading (privacy.html): the embers, kept calm behind the text, icons, and the header's line.
import { startEmbers } from './shared/ember.js';
import { fillIcons } from './ui/icons.js';

startEmbers(document.getElementById('embers'), { calm: () => document.querySelector('main') });
fillIcons(document);
const header = document.querySelector('header.site');
const onScroll = () => header?.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();
