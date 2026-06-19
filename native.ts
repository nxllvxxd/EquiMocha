import { dialog, IpcMainInvokeEvent } from "electron";
import { open, stat } from "fs/promises";

const MOCHA_BASE = "https://api.mocha.my";
const MOCHA_WEB = "https://mocha.my";
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const MIN_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE = 1000 * 1024 * 1024;
const HARD_MAX_PARTS = 10000;
const PART_RETRIES = 3;
const PART_UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const STREAM_READ_SIZE = 64 * 1024;

type NativeUploadResult = {
    success: boolean;
    url?: string;
    error?: string;
};

function describeError(error: unknown): string {
    if (!(error instanceof Error)) return "Unknown error";

    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) {
        const code = (cause as { code?: string }).code;
        return code ? `${error.message}: ${code} (${cause.message})` : `${error.message}: ${cause.message}`;
    }
    if (cause) return `${error.message}: ${String(cause)}`;

    return error.message;
}

type ChunkOptions = {
    chunkSizeMB?: number;
    maxChunks?: number;
};

function resolveChunkSize(fileSize: number, options?: ChunkOptions): number {
    const requestedBytes = options?.chunkSizeMB ? options.chunkSizeMB * 1024 * 1024 : DEFAULT_CHUNK_SIZE;
    const maxChunks = Math.min(HARD_MAX_PARTS, Math.max(1, options?.maxChunks ?? HARD_MAX_PARTS));

    let chunkSize = Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.round(requestedBytes)));

    // If the requested chunk size would split the file into more parts than
    // allowed, grow the chunk size so the part count stays within the cap.
    const minChunkSizeForCap = Math.ceil(fileSize / maxChunks);
    if (minChunkSizeForCap > chunkSize) {
        chunkSize = Math.min(MAX_CHUNK_SIZE, minChunkSizeForCap);
    }

    return chunkSize;
}

type NativeUploadProgress = {
    phase: "preparing" | "uploading" | "retrying" | "sharing" | "success" | "failed" | "cancelled";
    percent: number;
    transferredBytes: number;
    totalBytes: number;
    partNumber: number;
    totalParts: number;
    status: string;
};

type NativeUploadSession = {
    progress: NativeUploadProgress;
    controller: AbortController;
    cancelled: boolean;
};

type ExistingShareMatch = {
    url: string;
    token: string;
};

type ExistingMochaFile = {
    id: string;
    name: string;
    size: number;
    mimeType: string;
};

const activeUploads = new Map<string, NativeUploadSession>();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function today(): string {
    return formatLocalDate(0);
}

function formatLocalDate(offsetDays: number): string {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function getCandidateUploadFolders(): string[] {
    return [-1, 0, 1].map(offset => `/discord/${formatLocalDate(offset)}`);
}

function authHeaders(apiKey: string, extra: Record<string, string> = {}) {
    return {
        Authorization: `Bearer ${apiKey}`,
        ...extra
    };
}

function expiryHours(value: string): number | null {
    const map: Record<string, number> = {
        "1d": 24,
        "7d": 168,
        "30d": 720
    };

    return map[value] ?? null;
}

function getUploadSession(uploadKey: string): NativeUploadSession {
    const session = activeUploads.get(uploadKey);

    if (!session) {
        throw new Error("Upload session is no longer active");
    }

    if (session.cancelled) {
        throw new Error("Upload cancelled by user");
    }

    return session;
}

function setProgress(uploadKey: string, patch: Partial<NativeUploadProgress>) {
    const session = activeUploads.get(uploadKey);
    if (!session) return;

    session.progress = {
        ...session.progress,
        ...patch
    };
}

function progressBody(source: ArrayBuffer, onLoaded: (loaded: number) => void): ReadableStream<Uint8Array> {
    const view = new Uint8Array(source);
    let offset = 0;

    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= view.byteLength) {
                controller.close();
                return;
            }

            const end = Math.min(offset + STREAM_READ_SIZE, view.byteLength);
            controller.enqueue(view.subarray(offset, end));
            offset = end;
            onLoaded(offset);
        }
    });
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = PART_UPLOAD_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        } as RequestInit);
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromParent);
    }
}

async function ensureFolder(apiKey: string, path: string) {
    const parts = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    for (let i = 0; i < parts.length; i++) {
        const parent = `/${parts.slice(0, i).join("/")}`.replace(/\/$/, "") || "/";
        const name = parts[i];

        const response = await fetch(`${MOCHA_BASE}/api/files/folders`, {
            method: "POST",
            headers: authHeaders(apiKey, {
                "Content-Type": "application/json"
            }),
            body: JSON.stringify({
                path: parent,
                name
            })
        });

        if (!response.ok && response.status !== 409) {
            throw new Error(`Folder create failed: ${response.status} ${await response.text()}`);
        }
    }
}

function getFileId(data: any): string {
    const fileId = data?.fileId ?? data?.id ?? data?.file?.id;

    if (!fileId) {
        throw new Error("No file id returned from Mocha");
    }

    return String(fileId);
}

function getListedFileId(file: any): string {
    return String(file?.id ?? file?.fileId ?? file?.file_id ?? file?.uuid ?? "");
}

function getListedFileName(file: any): string {
    return String(
        file?.originalName
        ?? file?.original_name
        ?? file?.name
        ?? file?.fileName
        ?? file?.file_name
        ?? ""
    );
}

function getListedFileSize(file: any): number | null {
    return coerceSize(
        file?.fileSize
        ?? file?.file_size
        ?? file?.size
        ?? file?.bytes
    );
}

function getListedFileMimeType(file: any): string {
    return String(
        file?.mimeType
        ?? file?.mime_type
        ?? file?.contentType
        ?? file?.content_type
        ?? ""
    );
}

function normalizeFileName(value: unknown): string {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeMimeType(value: unknown): string {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isGenericMimeType(value: string): boolean {
    return !value || value === "application/octet-stream";
}

function coerceSize(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    return null;
}

function getShareToken(share: any): string {
    return String(share?.token ?? share?.shareToken ?? share?.id ?? "");
}

function getShareFileName(share: any): string {
    return String(
        share?.originalName
        ?? share?.original_name
        ?? share?.fileName
        ?? share?.file_name
        ?? share?.name
        ?? ""
    );
}

function getShareSize(share: any): number | null {
    return coerceSize(
        share?.fileSize
        ?? share?.file_size
        ?? share?.size
        ?? share?.bytes
    );
}

function getShareMimeType(share: any): string {
    return String(
        share?.mimeType
        ?? share?.mime_type
        ?? share?.contentType
        ?? share?.content_type
        ?? ""
    );
}

function isShareActive(share: any): boolean {
    return share?.is_active ?? share?.isActive ?? true;
}

function shareMatchesFile(share: any, filename: string, size: number, mimeType: string): boolean {
    const shareName = normalizeFileName(getShareFileName(share));
    if (shareName && shareName !== normalizeFileName(filename)) return false;

    const shareSize = getShareSize(share);
    if (shareSize !== null && shareSize !== size) return false;

    const shareMime = normalizeMimeType(getShareMimeType(share));
    const fileMime = normalizeMimeType(mimeType);
    if (shareMime && !isGenericMimeType(fileMime) && shareMime !== fileMime) return false;

    return Boolean(shareName) && shareSize === size;
}

function listedFileMatches(file: any, filename: string, size: number, mimeType: string): boolean {
    const fileId = getListedFileId(file);
    if (!fileId) return false;

    const listedName = normalizeFileName(getListedFileName(file));
    if (listedName && listedName !== normalizeFileName(filename)) return false;

    const listedSize = getListedFileSize(file);
    if (listedSize !== size) return false;

    const listedMime = normalizeMimeType(getListedFileMimeType(file));
    const targetMime = normalizeMimeType(mimeType);
    if (listedMime && !isGenericMimeType(targetMime) && listedMime !== targetMime) return false;

    return Boolean(listedName);
}

async function listFilesInFolder(apiKey: string, folderPath: string): Promise<any[]> {
    const url = new URL(`${MOCHA_BASE}/api/files`);
    url.searchParams.set("path", folderPath);
    url.searchParams.set("includeSubfolders", "1");

    const response = await fetchWithTimeout(url.toString(), {
        method: "GET",
        headers: authHeaders(apiKey)
    }, 30 * 1000);

    if (!response.ok) return [];

    const data = await response.json().catch(() => null);
    return Array.isArray(data?.files) ? data.files : [];
}

async function findExistingMochaFile(apiKey: string, filename: string, size: number, mimeType: string): Promise<ExistingMochaFile | null> {
    for (const folder of getCandidateUploadFolders()) {
        const files = await listFilesInFolder(apiKey, folder).catch(() => []);
        const match = files.find(file => listedFileMatches(file, filename, size, mimeType));

        if (!match) continue;

        return {
            id: getListedFileId(match),
            name: getListedFileName(match),
            size: getListedFileSize(match) ?? size,
            mimeType: getListedFileMimeType(match) || mimeType
        };
    }

    return null;
}

async function findExistingShare(apiKey: string, filename: string, size: number, mimeType: string): Promise<ExistingShareMatch | null> {
    const sharesResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/shares`, {
        method: "GET",
        headers: authHeaders(apiKey)
    }, 30 * 1000);

    if (!sharesResponse.ok) {
        return null;
    }

    const sharesData = await sharesResponse.json();
    const shares = Array.isArray(sharesData) ? sharesData : sharesData?.shares;
    if (!Array.isArray(shares)) return null;

    const targetName = normalizeFileName(filename);
    const likelyShares = shares.filter((share: any) => {
        if (!isShareActive(share)) return false;

        const token = getShareToken(share);
        if (!token) return false;

        if (shareMatchesFile(share, filename, size, mimeType)) return true;

        const listedName = normalizeFileName(getShareFileName(share));
        const listedSize = getShareSize(share);

        return !listedName || listedName === targetName || listedSize === size;
    });

    for (const share of likelyShares) {
        const token = getShareToken(share);
        if (!token) continue;

        if (shareMatchesFile(share, filename, size, mimeType)) {
            return { token, url: `${MOCHA_WEB}/share/${token}` };
        }

        const metadataResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/shares/${encodeURIComponent(token)}`, {
            method: "GET"
        }, 15 * 1000).catch(() => null);

        if (!metadataResponse?.ok) continue;

        const metadata = await metadataResponse.json().catch(() => null);
        const publicShare = metadata?.share ?? metadata;

        if (isShareActive(publicShare) && shareMatchesFile(publicShare, filename, size, mimeType)) {
            return { token, url: `${MOCHA_WEB}/share/${token}` };
        }
    }

    return null;
}

async function getExistingShareOrCreateForFile(
    apiKey: string,
    file: ExistingMochaFile,
    requestedFilename: string,
    requestedSize: number,
    requestedMimeType: string,
    shareExpiry: string
): Promise<ExistingShareMatch> {
    const existingShare = await findExistingShare(apiKey, requestedFilename, requestedSize, requestedMimeType).catch(() => null);
    if (existingShare) return existingShare;

    return {
        token: "",
        url: await createShare(apiKey, file.id, shareExpiry)
    };
}

async function findExistingMochaShareOrCreate(apiKey: string, filename: string, size: number, mimeType: string, shareExpiry: string): Promise<ExistingShareMatch | null> {
    const existingFile = await findExistingMochaFile(apiKey, filename, size, mimeType);
    if (!existingFile) return null;

    return getExistingShareOrCreateForFile(apiKey, existingFile, filename, size, mimeType, shareExpiry);
}

async function getPresignedPartUrl(apiKey: string, session: any, partNumber: number): Promise<string> {
    const response = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/presigned`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            partNumbers: [partNumber],
            expiresInSeconds: 3600
        })
    }, 30 * 1000);

    if (!response.ok) {
        throw new Error(`Presign part ${partNumber} failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    if (typeof data?.url === "string") return data.url;
    if (typeof data?.presignedUrl === "string") return data.presignedUrl;

    const partUrl = Array.isArray(data?.urls)
        ? data.urls.find((entry: any) => entry?.partNumber === partNumber)?.url
        : null;

    if (typeof partUrl !== "string") {
        throw new Error(`No presigned URL returned for part ${partNumber}`);
    }

    return partUrl;
}

async function uploadPart(
    uploadKey: string,
    apiKey: string,
    session: any,
    chunk: ArrayBuffer,
    partNumber: number,
    totalParts: number,
    completedBytes: number,
    totalBytes: number
): Promise<string> {
    for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
        getUploadSession(uploadKey);

        try {
            setProgress(uploadKey, {
                phase: attempt === 1 ? "uploading" : "retrying",
                partNumber,
                totalParts,
                status: attempt === 1
                    ? `Uploading part ${partNumber}/${totalParts} via Mocha...`
                    : `Retrying part ${partNumber}/${totalParts} via Mocha...`
            });

            const presignedUrl = await getPresignedPartUrl(apiKey, session, partNumber);

            const uploadSession = getUploadSession(uploadKey);
            const response = await fetchWithTimeout(presignedUrl, {
                method: "PUT",
                signal: uploadSession.controller.signal,
                headers: { "Content-Length": String(chunk.byteLength) },
                duplex: "half",
                body: progressBody(chunk, loaded => {
                    const transferredBytes = Math.min(totalBytes, completedBytes + loaded);
                    setProgress(uploadKey, {
                        phase: "uploading",
                        percent: Math.min(99, Math.round(transferredBytes / totalBytes * 100)),
                        transferredBytes,
                        totalBytes,
                        partNumber,
                        totalParts,
                        status: `Uploading part ${partNumber}/${totalParts} via Mocha...`
                    });
                })
            } as RequestInit & { duplex: "half"; });

            getUploadSession(uploadKey);

            if (!response.ok) {
                throw new Error(`Part ${partNumber} failed: ${response.status} ${await response.text()}`);
            }

            const etag = response.headers.get("ETag");

            if (!etag) {
                throw new Error(`No ETag returned for part ${partNumber}`);
            }

            return etag;
        } catch (error) {
            if (attempt === PART_RETRIES) {
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
    }

    throw new Error(`Part ${partNumber} failed`);
}

async function abortMultipart(apiKey: string, session: any, totalParts: number) {
    await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/abort`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            partNumbers: Array.from({ length: totalParts }, (_, index) => index + 1)
        })
    }, 15 * 1000).catch(() => undefined);
}

async function uploadMultipart(
    uploadKey: string,
    apiKey: string,
    fileBuffer: ArrayBuffer,
    filename: string,
    mimeType: string,
    destinationFolder: string,
    chunkOptions?: ChunkOptions
): Promise<string> {
    const remotePath = `${destinationFolder}/`;
    const size = fileBuffer.byteLength;
    const chunkSize = resolveChunkSize(size, chunkOptions);
    const initResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/init`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            originalName: filename,
            path: remotePath,
            size,
            mimeType,
            partSizeBytes: chunkSize,
            strategy: "s3"
        })
    }, 30 * 1000);

    if (!initResponse.ok) {
        throw new Error(`Multipart init failed: ${initResponse.status} ${await initResponse.text()}`);
    }

    const initData = await initResponse.json();

    if (initData.strategy !== "s3") {
        throw new Error(`Expected S3 multipart strategy but server returned: ${initData.strategy}`);
    }

    const session = {
        strategy: "s3" as const,
        uploadId: initData.uploadId,
        key: initData.key,
        nodeId: initData.nodeId,
        originalName: filename,
        path: remotePath
    };

    if (!session.uploadId || !session.key || !session.nodeId) {
        throw new Error(`Invalid multipart init response: ${JSON.stringify(initData)}`);
    }

    const totalParts = Math.ceil(size / chunkSize);
    const parts: Array<{ partNumber: number; etag: string; }> = [];
    let completedBytes = 0;

    try {
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
            getUploadSession(uploadKey);

            const offset = (partNumber - 1) * chunkSize;
            const chunk = fileBuffer.slice(offset, Math.min(size, offset + chunkSize));
            const etag = await uploadPart(uploadKey, apiKey, session, chunk, partNumber, totalParts, completedBytes, size);

            completedBytes += chunk.byteLength;
            parts.push({ partNumber, etag });
            setProgress(uploadKey, {
                phase: "uploading",
                percent: Math.min(99, Math.round(completedBytes / size * 100)),
                transferredBytes: completedBytes,
                totalBytes: size,
                partNumber,
                totalParts,
                status: `Uploaded part ${partNumber}/${totalParts}.`
            });
        }
    } catch (error) {
        await abortMultipart(apiKey, session, totalParts);
        throw error;
    }

    setProgress(uploadKey, {
        phase: "uploading",
        percent: 99,
        transferredBytes: size,
        totalBytes: size,
        partNumber: totalParts,
        totalParts,
        status: "Finalizing multipart upload..."
    });

    const completeResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/complete`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            size,
            mimeType,
            parts: parts.sort((a, b) => a.partNumber - b.partNumber)
        })
    }, 60 * 1000);

    if (!completeResponse.ok) {
        throw new Error(`Multipart complete failed: ${completeResponse.status} ${await completeResponse.text()}`);
    }

    return getFileId(await completeResponse.json());
}

async function uploadMultipartFromPath(
    uploadKey: string,
    apiKey: string,
    filePath: string,
    size: number,
    filename: string,
    mimeType: string,
    destinationFolder: string,
    chunkOptions?: ChunkOptions
): Promise<string> {
    const remotePath = `${destinationFolder}/`;
    const chunkSize = resolveChunkSize(size, chunkOptions);
    const initResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/init`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            originalName: filename,
            path: remotePath,
            size,
            mimeType,
            partSizeBytes: chunkSize,
            strategy: "s3"
        })
    }, 30 * 1000);

    if (!initResponse.ok) {
        throw new Error(`Multipart init failed: ${initResponse.status} ${await initResponse.text()}`);
    }

    const initData = await initResponse.json();

    if (initData.strategy !== "s3") {
        throw new Error(`Expected S3 multipart strategy but server returned: ${initData.strategy}`);
    }

    const session = {
        strategy: "s3" as const,
        uploadId: initData.uploadId,
        key: initData.key,
        nodeId: initData.nodeId,
        originalName: filename,
        path: remotePath
    };

    if (!session.uploadId || !session.key || !session.nodeId) {
        throw new Error(`Invalid multipart init response: ${JSON.stringify(initData)}`);
    }

    const totalParts = Math.ceil(size / chunkSize);
    const parts: Array<{ partNumber: number; etag: string; }> = [];
    let completedBytes = 0;
    const handle = await open(filePath, "r");

    try {
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
            getUploadSession(uploadKey);

            const offset = (partNumber - 1) * chunkSize;
            const readSize = Math.min(chunkSize, size - offset);
            const buffer = Buffer.allocUnsafe(readSize);
            const { bytesRead } = await handle.read(buffer, 0, readSize, offset);
            const chunk = toArrayBuffer(buffer.subarray(0, bytesRead));
            const etag = await uploadPart(uploadKey, apiKey, session, chunk, partNumber, totalParts, completedBytes, size);

            completedBytes += bytesRead;
            parts.push({ partNumber, etag });
            setProgress(uploadKey, {
                phase: "uploading",
                percent: Math.min(99, Math.round(completedBytes / size * 100)),
                transferredBytes: completedBytes,
                totalBytes: size,
                partNumber,
                totalParts,
                status: `Uploaded part ${partNumber}/${totalParts}.`
            });
        }
    } catch (error) {
        await abortMultipart(apiKey, session, totalParts);
        throw error;
    } finally {
        await handle.close();
    }

    setProgress(uploadKey, {
        phase: "uploading",
        percent: 99,
        transferredBytes: size,
        totalBytes: size,
        partNumber: totalParts,
        totalParts,
        status: "Finalizing multipart upload..."
    });

    const completeResponse = await fetchWithTimeout(`${MOCHA_BASE}/api/files/multipart/complete`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify({
            ...session,
            size,
            mimeType,
            parts: parts.sort((a, b) => a.partNumber - b.partNumber)
        })
    }, 60 * 1000);

    if (!completeResponse.ok) {
        throw new Error(`Multipart complete failed: ${completeResponse.status} ${await completeResponse.text()}`);
    }

    return getFileId(await completeResponse.json());
}

async function createShare(apiKey: string, fileId: string, shareExpiry: string): Promise<string> {
    const payload: Record<string, unknown> = { fileId };
    const hours = expiryHours(shareExpiry);

    if (hours !== null) {
        payload.expiresInHours = hours;
    }

    const response = await fetch(`${MOCHA_BASE}/api/shares`, {
        method: "POST",
        headers: authHeaders(apiKey, {
            "Content-Type": "application/json"
        }),
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Share create failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const token = data?.token ?? data?.share?.token;

    if (!token) {
        throw new Error("No share token returned from Mocha");
    }

    return `${MOCHA_WEB}/share/${token}`;
}

export async function fetchUrlAndUpload(
    _: IpcMainInvokeEvent,
    sourceUrl: string,
    filename: string,
    apiKey: string,
    shareExpiry: string,
    uploadKey: string,
    chunkOptions?: ChunkOptions
): Promise<NativeUploadResult> {
    activeUploads.set(uploadKey, {
        cancelled: false,
        controller: new AbortController(),
        progress: {
            phase: "preparing",
            percent: 1,
            transferredBytes: 0,
            totalBytes: 0,
            partNumber: 0,
            totalParts: 0,
            status: "Fetching file..."
        }
    });

    try {
        const uploadSession = getUploadSession(uploadKey);
        const fetchResponse = await fetchWithTimeout(sourceUrl, {
            method: "GET",
            signal: uploadSession.controller.signal
        }, 5 * 60 * 1000);

        if (!fetchResponse.ok) {
            throw new Error(`Failed to fetch file: ${fetchResponse.status}`);
        }

        const contentType = fetchResponse.headers.get("content-type") || "application/octet-stream";
        const mimeType = contentType.split(";")[0].trim() || "application/octet-stream";
        const fileBuffer = await fetchResponse.arrayBuffer();

        getUploadSession(uploadKey);

        activeUploads.get(uploadKey)!.progress.totalBytes = fileBuffer.byteLength;

        const destinationFolder = `/discord/${today()}`;
        const resolvedMimeType = mimeType || "application/octet-stream";

        setProgress(uploadKey, {
            phase: "preparing",
            percent: 1,
            transferredBytes: 0,
            totalBytes: fileBuffer.byteLength,
            status: "Checking Mocha for an existing share..."
        });

        const existingShare = await findExistingMochaShareOrCreate(apiKey, filename, fileBuffer.byteLength, resolvedMimeType, shareExpiry).catch(() => null);
        if (existingShare) {
            setProgress(uploadKey, {
                phase: "success",
                percent: 100,
                transferredBytes: fileBuffer.byteLength,
                totalBytes: fileBuffer.byteLength,
                status: "Existing Mocha share found."
            });

            return { success: true, url: existingShare.url };
        }

        await ensureFolder(apiKey, destinationFolder);

        const fileId = await uploadMultipart(uploadKey, apiKey, fileBuffer, filename, resolvedMimeType, destinationFolder, chunkOptions);

        setProgress(uploadKey, {
            phase: "sharing",
            percent: 99,
            transferredBytes: fileBuffer.byteLength,
            totalBytes: fileBuffer.byteLength,
            status: "Creating Mocha share link..."
        });

        return {
            success: true,
            url: await createShare(apiKey, fileId, shareExpiry)
        };
    } catch (error) {
        setProgress(uploadKey, {
            phase: activeUploads.get(uploadKey)?.cancelled ? "cancelled" : "failed",
            status: describeError(error)
        });

        return {
            success: false,
            error: describeError(error)
        };
    } finally {
        setTimeout(() => activeUploads.delete(uploadKey), 10 * 1000);
    }
}

export async function uploadToMocha(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    mimeType: string,
    apiKey: string,
    shareExpiry: string,
    uploadKey: string,
    chunkOptions?: ChunkOptions
): Promise<NativeUploadResult> {
    activeUploads.set(uploadKey, {
        cancelled: false,
        controller: new AbortController(),
        progress: {
            phase: "preparing",
            percent: 1,
            transferredBytes: 0,
            totalBytes: fileBuffer.byteLength,
            partNumber: 0,
            totalParts: 0,
            status: "Preparing upload..."
        }
    });

    try {
        const destinationFolder = `/discord/${today()}`;
        const resolvedMimeType = mimeType || "application/octet-stream";

        setProgress(uploadKey, {
            phase: "preparing",
            percent: 1,
            transferredBytes: 0,
            totalBytes: fileBuffer.byteLength,
            status: "Checking Mocha for an existing share..."
        });

        const existingShare = await findExistingMochaShareOrCreate(apiKey, filename, fileBuffer.byteLength, resolvedMimeType, shareExpiry).catch(() => null);
        if (existingShare) {
            setProgress(uploadKey, {
                phase: "success",
                percent: 100,
                transferredBytes: fileBuffer.byteLength,
                totalBytes: fileBuffer.byteLength,
                status: "Existing Mocha share found."
            });

            return {
                success: true,
                url: existingShare.url
            };
        }

        await ensureFolder(apiKey, destinationFolder);

        const fileId = await uploadMultipart(uploadKey, apiKey, fileBuffer, filename, resolvedMimeType, destinationFolder, chunkOptions);

        setProgress(uploadKey, {
            phase: "sharing",
            percent: 99,
            transferredBytes: fileBuffer.byteLength,
            totalBytes: fileBuffer.byteLength,
            status: "Creating Mocha share link..."
        });

        return {
            success: true,
            url: await createShare(apiKey, fileId, shareExpiry)
        };
    } catch (error) {
        setProgress(uploadKey, {
            phase: activeUploads.get(uploadKey)?.cancelled ? "cancelled" : "failed",
            status: describeError(error)
        });

        return {
            success: false,
            error: describeError(error)
        };
    } finally {
        setTimeout(() => activeUploads.delete(uploadKey), 10 * 1000);
    }
}

export async function uploadPathToMocha(
    _: IpcMainInvokeEvent,
    filePath: string,
    filename: string,
    mimeType: string,
    apiKey: string,
    shareExpiry: string,
    uploadKey: string,
    chunkOptions?: ChunkOptions
): Promise<NativeUploadResult> {
    const fileStat = await stat(filePath);
    activeUploads.set(uploadKey, {
        cancelled: false,
        controller: new AbortController(),
        progress: {
            phase: "preparing",
            percent: 1,
            transferredBytes: 0,
            totalBytes: fileStat.size,
            partNumber: 0,
            totalParts: 0,
            status: "Preparing upload..."
        }
    });

    try {
        const destinationFolder = `/discord/${today()}`;
        const resolvedMimeType = mimeType || "application/octet-stream";

        setProgress(uploadKey, {
            phase: "preparing",
            percent: 1,
            transferredBytes: 0,
            totalBytes: fileStat.size,
            status: "Checking Mocha for an existing share..."
        });

        const existingShare = await findExistingMochaShareOrCreate(apiKey, filename, fileStat.size, resolvedMimeType, shareExpiry).catch(() => null);
        if (existingShare) {
            setProgress(uploadKey, {
                phase: "success",
                percent: 100,
                transferredBytes: fileStat.size,
                totalBytes: fileStat.size,
                status: "Existing Mocha share found."
            });

            return {
                success: true,
                url: existingShare.url
            };
        }

        await ensureFolder(apiKey, destinationFolder);

        const fileId = await uploadMultipartFromPath(uploadKey, apiKey, filePath, fileStat.size, filename, resolvedMimeType, destinationFolder, chunkOptions);

        setProgress(uploadKey, {
            phase: "sharing",
            percent: 99,
            transferredBytes: fileStat.size,
            totalBytes: fileStat.size,
            status: "Creating Mocha share link..."
        });

        return {
            success: true,
            url: await createShare(apiKey, fileId, shareExpiry)
        };
    } catch (error) {
        setProgress(uploadKey, {
            phase: activeUploads.get(uploadKey)?.cancelled ? "cancelled" : "failed",
            status: describeError(error)
        });

        return {
            success: false,
            error: describeError(error)
        };
    } finally {
        setTimeout(() => activeUploads.delete(uploadKey), 10 * 1000);
    }
}

export async function getUploadProgress(_: IpcMainInvokeEvent, uploadKey: string): Promise<NativeUploadProgress | null> {
    return activeUploads.get(uploadKey)?.progress ?? null;
}

export async function cancelUpload(_: IpcMainInvokeEvent, uploadKey: string): Promise<void> {
    const session = activeUploads.get(uploadKey);
    if (!session) return;

    session.cancelled = true;
    session.controller.abort();
    setProgress(uploadKey, {
        phase: "cancelled",
        status: "Upload cancelled."
    });
}

export async function chooseFilePath(_: IpcMainInvokeEvent): Promise<{ path: string; name: string; } | null> {
    const result = await dialog.showOpenDialog({
        properties: ["openFile"]
    });

    if (result.canceled || !result.filePaths.length) {
        return null;
    }

    const path = result.filePaths[0];
    const name = path.split(/[\\/]/).pop() || "upload.bin";

    return { path, name };
}