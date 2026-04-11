declare module 'openclaw/plugin-sdk/plugin-entry' {
  interface PluginTool {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    execute: (args: any) => Promise<{ content: { type: string, text: string }[] }>
  }

  interface PluginApi {
    registerTool: (tool: PluginTool) => void
    on: (event: string, handler: (event: any) => Promise<Record<string, unknown>>) => void
  }

  interface PluginEntry {
    id: string
    name: string
    description: string
    kind: string
    register: (api: PluginApi) => void
  }

  export function definePluginEntry (entry: PluginEntry): PluginEntry
}
