
export type MediaTrackConstraints = {
    width?: ConstrainNumber;
    height?: ConstrainNumber;
    frameRate?: ConstrainNumber;
    facingMode?: ConstrainString;
    deviceId?: ConstrainString;
    groupId?: ConstrainString;

    // Audio processing, applied to the track as it is sent.
    autoGainControl?: ConstrainBoolean;
    echoCancellation?: ConstrainBoolean;
    noiseSuppression?: ConstrainBoolean;
}

type ConstrainBoolean = boolean | {
    exact?: boolean,
    ideal?: boolean,
}

type ConstrainNumber = number | {
    exact?: number,
    ideal?: number,
    max?: number,
    min?: number,
}

type ConstrainString = string | {
    exact?: string,
    ideal?: string,
}