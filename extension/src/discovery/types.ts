export interface EditorRegistration {
    projectName: string;
    projectPath: string;
    scriptRootPaths: string[];
    port: number;
    pid: number;
    engineVersion: string;
    startTime: string;
}

export interface WindowRegistration {
    scriptRootPaths: string[];
    pid: number;
    heartbeat: string;
}
