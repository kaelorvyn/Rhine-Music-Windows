// Only module metadata is public. No credential-file decoder is shipped.
import { moduleStatus, importModule, removeModule } from './pool-module.mjs'
export const status = () => ({ ...moduleStatus(), note: moduleStatus().configured ? null : '未导入可用模块，当前只使用备用音源' })
export const importDll = importModule
export const clear = removeModule
export const signNote = health => health?.ok ? null : '共享音源模块未就绪，请检查或重新导入 DLL 模块'
