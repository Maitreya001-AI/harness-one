// Ambient module declarations for optional peer dependencies that are NOT
// installed in the examples workspace. Typechecking treats them as `any` so
// readers can see the full example text without running `npm install` for
// every provider SDK. Namespace access like `Anthropic.Tool.InputSchema` is
// modelled via `namespace` + `any` so demos keep compiling.

declare module '@anthropic-ai/sdk' {
  // The Anthropic SDK exposes a default-exported class that also doubles as
  // a namespace carrying the API types (`Anthropic.MessageParam`,
  // `Anthropic.Tool.InputSchema`, etc.). We model it as a merged
  // class + namespace so `new Anthropic({...})` and `Anthropic.MessageParam`
  // both compile against `any` without requiring the SDK to be installed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class Anthropic {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config?: any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Anthropic {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type MessageParam = any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type ContentBlockParam = any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type Tool = any;
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Tool {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      export type InputSchema = any;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type Usage = any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type Message = any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type TextBlock = any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type ToolUseBlock = any;
  }
  export default Anthropic;
  // Re-export namespace members as top-level types so named imports also work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type MessageParam = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ContentBlockParam = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Tool = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Usage = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Message = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type TextBlock = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ToolUseBlock = any;
}

// Examples also reference `Anthropic.TextBlock` / `Anthropic.ToolUseBlock`
// namespace-style on the default import. Model the default import as both a
// value and a namespace so `new Anthropic(...)`, `client: Anthropic`, and
// `Anthropic.TextBlock` all compile against `any`.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Anthropic {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type TextBlock = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ToolUseBlock = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Message = any;
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Tool {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type InputSchema = any;
  }
}
// Same story for the `openai` package: examples use `OpenAI.Chat.Completions.*`
// as types. Ambient namespace provides `any`-typed leaf types.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace OpenAI {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Chat {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Completions {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      export type ChatCompletionMessageParam = any;
      // eslint-disable-next-line @typescript-eslint/no-namespace
      export namespace ChatCompletion {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        export type Choice = any;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      export type ChatCompletion = any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      export type ChatCompletionChunk = any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      export type ChatCompletionTool = any;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Completions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type CompletionUsage = any;
  }
}

declare module 'openai' {
  // Same merged class + namespace pattern used for `@anthropic-ai/sdk`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class OpenAI {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config?: any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace OpenAI {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Chat {
      // eslint-disable-next-line @typescript-eslint/no-namespace
      export namespace Completions {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        export type ChatCompletionMessageParam = any;
        // eslint-disable-next-line @typescript-eslint/no-namespace
        export namespace ChatCompletion {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          export type Choice = any;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        export type ChatCompletion = any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        export type ChatCompletionChunk = any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        export type ChatCompletionTool = any;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-namespace
    export namespace Completions {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      export type CompletionUsage = any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      export type ChatCompletionMessageParam = any;
    }
  }
  export default OpenAI;
}

declare module 'tiktoken' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function encoding_for_model(model: any): {
    encode: (text: string) => number[];
    free: () => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type TiktokenModel = any;
}

declare module 'langfuse' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Langfuse: any;
}

declare module 'ioredis' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Redis: any;
  export default Redis;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Redis = any;
}

declare module 'ajv' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ajv: any;
  export default Ajv;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ValidateFunction = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export { Ajv };
}

declare module 'ajv-formats' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addFormats: any;
  export default addFormats;
}

declare module '@opentelemetry/api' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const trace: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const context: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const SpanStatusCode: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Span = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Tracer = any;
}

declare module '@opentelemetry/sdk-trace-base' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x: any;
  export = x;
}

declare module '@pinecone-database/pinecone' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Pinecone: any;
  export { Pinecone };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Index = any;
}
