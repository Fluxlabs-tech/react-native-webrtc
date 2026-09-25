/**
 * The codegen modules the native specs import, for type checking against @types/react-native,
 * which predates them. Copied from React Native's own declarations (types/modules/Codegen.d.ts),
 * which apps on React Native 0.71 and later get instead; this file is not published.
 */

declare module 'react-native/Libraries/Utilities/codegenNativeCommands' {
    export interface Options<T extends string> {
        readonly supportedCommands: ReadonlyArray<T>;
    }

    function codegenNativeCommands<T extends object>(
        options: Options<keyof T extends string ? keyof T : never>,
    ): T;

    export default codegenNativeCommands;
}

declare module 'react-native/Libraries/Utilities/codegenNativeComponent' {
    import type { HostComponent } from 'react-native';

    export interface Options {
        readonly interfaceOnly?: boolean | undefined;
        readonly paperComponentName?: string | undefined;
        readonly paperComponentNameDeprecated?: string | undefined;
        readonly excludedPlatforms?: ReadonlyArray<'iOS' | 'android'> | undefined;
    }

    function codegenNativeComponent<Props extends object>(
        componentName: string,
        options?: Options,
    ): HostComponent<Props>;

    export default codegenNativeComponent;
}

declare module 'react-native/Libraries/Types/CodegenTypes' {
    import type { NativeSyntheticEvent } from 'react-native';

    export type BubblingEventHandler<T> = (event: NativeSyntheticEvent<T>) => void | Promise<void>;
    export type DirectEventHandler<T> = (event: NativeSyntheticEvent<T>) => void | Promise<void>;

    export type Double = number;
    export type Float = number;
    export type Int32 = number;
    export type UnsafeObject = object;

    type DefaultTypes = number | boolean | string | ReadonlyArray<string>;

    export type EventEmitter<T> = (handler: (arg: T) => void | Promise<void>) => { remove(): void };

    export type WithDefault<
        Type extends DefaultTypes,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        Value extends Type | string | undefined | null,
    > = Type | undefined | null;
}
