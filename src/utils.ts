import fs from 'fs-extra';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { FileNode, MediaInfo } from './types';

const localBin = path.join(process.cwd(), 'bin'); 
const ffmpegExe = path.join(localBin, 'ffmpeg.exe');
const ffprobeExe = path.join(localBin, 'ffprobe.exe');

console.log("Using Manual FFmpeg:", ffmpegExe);

ffmpeg.setFfmpegPath(ffmpegExe);
ffmpeg.setFfprobePath(ffprobeExe);

export const DATA_DIR = path.join(process.cwd(), 'data');
export const FILES_JSON = path.join(DATA_DIR, 'files.json');
export const CONFIG_JSON = path.join(DATA_DIR, 'config.json');

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(path.join(process.cwd(), 'images/posters'));
fs.ensureDirSync(path.join(process.cwd(), 'temp'));
fs.ensureDirSync(path.join(process.cwd(), 'uploads'));

export const readJSON = (file: string): any => {
    if (!fs.existsSync(file)) return null;
    return fs.readJsonSync(file, { throws: false }) || null;
};

export const writeJSON = (file: string, data: any) => {
    fs.writeJsonSync(file, data, { spaces: 2 });
};

const getVideoMetadata = (filePath: string): Promise<MediaInfo | null> => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
            if (err) {
                return resolve(null);
            }

            const videoStream = data.streams.find(s => s.codec_type === 'video');
            if (!videoStream) return resolve(null);

            let codec = videoStream.codec_name || 'unknown';
            if (codec === 'hevc') codec = 'H.265';
            if (codec === 'h264') codec = 'H.264';

            resolve({
                duration: data.format.duration ? parseFloat(data.format.duration.toString()) : 0,
                codec: codec,
                width: videoStream.width || 0,
                height: videoStream.height || 0
            });
        });
    });
};

const findNodeByPath = (nodes: FileNode[], searchPath: string): FileNode | null => {
    for (const node of nodes) {
        if (node.path === searchPath) return node;
        if (node.children) {
            const found = findNodeByPath(node.children, searchPath);
            if (found) return found;
        }
    }
    return null;
};

export const findNodeByUUID = (nodes: FileNode[], uuid: string): FileNode | null => {
    for (const node of nodes) {
        if (node.uuid === uuid) return node;
        if (node.children) {
            const found = findNodeByUUID(node.children, uuid);
            if (found) return found;
        }
    }
    return null;
};

export const flattenFiles = (nodes: FileNode[], list: FileNode[] = []): FileNode[] => {
    for (const node of nodes) {
        if (node.type === 'file') list.push(node);
        if (node.children) flattenFiles(node.children, list);
    }
    return list;
};

export const scanDirectory = async (
    dirPath: string, 
    oldData: FileNode[] = [],
    onProgress?: (message: string) => void
): Promise<FileNode[]> => {
    
    let items: string[] = [];
    try {
        items = fs.readdirSync(dirPath);
    } catch (e) {
        return [];
    }

    const results = await Promise.all(items.map(async (item) => {
        const fullPath = path.join(dirPath, item);
        
        if (onProgress) onProgress(`Scanning: ${item}`);

        let stats;
        try {
            stats = fs.statSync(fullPath);
        } catch (e) { return null; }

        const isDirectory = stats.isDirectory();
        const mtime = stats.mtime.toISOString();
        
        let node: FileNode = {
            uuid: uuidv4(),
            name: item,
            type: isDirectory ? 'directory' : 'file',
            path: fullPath,
            size: 0,
            mtime: mtime,
            children: [],
        };

        const oldNode = findNodeByPath(oldData, fullPath);
        let isUnchanged = false;

        if (oldNode) {
            if (!isDirectory && oldNode.mtime === mtime) isUnchanged = true;
            else if (isDirectory) isUnchanged = true;

            if (isUnchanged) {
                node.uuid = oldNode.uuid;
                node.meta = oldNode.meta; 
                node.subtitles = oldNode.subtitles;
                node.mediaInfo = oldNode.mediaInfo; 
            } else {
                node.uuid = oldNode.uuid;
                
                if (onProgress) onProgress(`File Changed: ${item} (Resetting Meta)`);
            }
        }

        if (isDirectory) {
            node.children = await scanDirectory(fullPath, oldData, onProgress);
            
            node.size = (node.children || []).reduce((acc, child) => acc + child.size, 0);
            
            const totalDuration = (node.children || []).reduce((acc, child) => acc + (child.mediaInfo?.duration || 0), 0);
            if (totalDuration > 0) {
                node.mediaInfo = { duration: totalDuration, codec: 'mixed', width: 0, height: 0 };
            }

        } else {
            node.size = stats.size;
            const ext = path.extname(item).toLowerCase();
            const isVideo = ['.mp4', '.mkv', '.avi', '.webm', '.m4v'].includes(ext);

            if (isVideo) {
                if (!isUnchanged || !node.mediaInfo) {
                    
                    if (onProgress) onProgress(`Analyzing Video: ${item}...`);
                    
                    const info = await getVideoMetadata(fullPath);
                    if (info) {
                        node.mediaInfo = info;
                    }
                }
            }
        }

        return node;
    }));

    return results.filter(n => n !== null) as FileNode[];
};