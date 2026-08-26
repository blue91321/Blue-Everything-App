/**
 * The lazy entry point for the vault screen.
 *
 * A separate file from `Vault.tsx` so the glob in `../index.ts` has one
 * predictable filename to look for in every feature, whatever the component
 * inside happens to be called.
 */
import { Vault } from './Vault';

export default Vault;
