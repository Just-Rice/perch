// Pages of plain reading (privacy.html): only the moving background, kept faint behind the text column.
import { startCipher } from './shared/cipher.js';

startCipher(document.getElementById('cipher'), { calm: () => document.querySelector('main') });
