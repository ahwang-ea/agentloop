const line = (message: string) => `${message}\n`;

export const writeStderr = (message: string) => { process.stderr.write(line(message)); };

export const writeStderrIf = (enabled: boolean, message: string) => { if (enabled) writeStderr(message); };
