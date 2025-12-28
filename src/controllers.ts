import { Request, Response } from 'express';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import archiver from 'archiver';
import mime from 'mime-types';
import { FILES_JSON, CONFIG_JSON, readJSON, writeJSON, scanDirectory, findNodeByUUID, flattenFiles } from './utils';
import { FileNode, MetaData, MetadataState, Subtitle } from './types';

const ffmpegPath = require('ffmpeg-static');
const ffprobeInstaller = require('ffprobe-static');
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeInstaller.path) ffmpeg.setFfprobePath(ffprobeInstaller.path);

// 1. PUT Root Drive
export const setRootDrive = (req: Request, res: Response) => {
    const { drive } = req.body;
    if (!drive) return res.status(400).json({ error: "Drive is required" });
    writeJSON(CONFIG_JSON, { rootDrive: drive });
    res.json({ message: "Root drive updated", drive });
};

// 2. POST Sync
export const syncFiles = async (req: Request, res: Response) => {
    const config = readJSON(CONFIG_JSON);
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (!config?.rootDrive) {
        res.write(`data: ${JSON.stringify({ status: "error", message: "Root drive not set" })}\n\n`);
        return res.end();
    }

    const currentData = readJSON(FILES_JSON) || [];
    
    res.write(`data: ${JSON.stringify({ status: "start", message: `Starting sync on ${config.rootDrive}` })}\n\n`);
    
    try {
        const newData = await scanDirectory(config.rootDrive, currentData, (msg) => {
            res.write(`data: ${JSON.stringify({ status: "progress", message: msg })}\n\n`);
        });
        
        writeJSON(FILES_JSON, newData);
        
        const summary = {
            totalFiles: flattenFiles(newData).length,
            rootChildren: newData.length
        };

        res.write(`data: ${JSON.stringify({ status: "done", message: "Sync Completed", summary })}\n\n`);
        res.end();

    } catch (error: any) {
        console.error(error);
        res.write(`data: ${JSON.stringify({ status: "error", message: error.message || "Sync Failed" })}\n\n`);
        res.end();
    }
};

// 3. PUT Update Meta (TMDB)
export const updateMeta = async (req: Request, res: Response) => {
    const { uuid } = req.params;
    const { type, tmdbId, season_number, episode_number, title, overview, poster, releaseDate, genres, rating, runtime, state } = req.body;

    const allFiles = readJSON(FILES_JSON);
    const node = findNodeByUUID(allFiles, uuid);

    if (!node) return res.status(404).json({ error: "File not found" });

    const validStates: MetadataState[] = ['Unset', 'Sync TMDB', 'Manual Set', 'Extract Subs', 'Set Subs'];

    try {
        let newMeta: MetaData;

        if (!process.env.TMDB_ACCESS_TOKEN) return res.status(500).json({ error: "TMDB Token missing" });

        const token = process.env.TMDB_ACCESS_TOKEN;
        const headers = { Authorization: `Bearer ${token}`, accept: 'application/json' };
        
        let url = '';
        if (type === 'movie') url = `https://api.themoviedb.org/3/movie/${tmdbId}?language=en-US`;
        else if (type === 'tv') url = `https://api.themoviedb.org/3/tv/${tmdbId}?language=en-US`;
        else if (type === 'season') url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season_number}?language=en-US`;
        else if (type === 'episode') url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season_number}/episode/${episode_number}?language=en-US`;
        else return res.status(400).json({ error: "Invalid type for Sync" });

        const { data: tmdb } = await axios.get(url, { headers });

        const imagePath = tmdb.poster_path || tmdb.still_path;
        let localPosterPath = node.meta?.poster || null;

        if (imagePath) {
            const fileName = `${uuid}${path.extname(imagePath) || '.jpg'}`;
            const saveDir = path.join(process.cwd(), 'images/posters');
            fs.ensureDirSync(saveDir);
            
            const savePath = path.join(saveDir, fileName);
            
            const writer = fs.createWriteStream(savePath);
            const imgRes = await axios({ 
                url: `https://image.tmdb.org/t/p/w500${imagePath}`, 
                method: 'GET', 
                responseType: 'stream' 
            });
            
            imgRes.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            
            localPosterPath = `images/posters/${fileName}`;
        }

        newMeta = {
            type: type || 'movie',
            tmdbId: tmdbId,
            title: tmdb.title || tmdb.name || tmdb.original_name || "Unknown",
            rating: tmdb.vote_average || 0,
            year: (tmdb.release_date || tmdb.first_air_date || tmdb.air_date || "").substring(0, 4),
            genres: tmdb.genres ? tmdb.genres.map((g: any) => g.name) : [],
            countries: tmdb.production_countries ? tmdb.production_countries.map((c: any) => c.name) : [],
            poster: localPosterPath,
            runtime: tmdb.runtime || (tmdb.episode_run_time ? tmdb.episode_run_time[0] : 0) || 0,
            episode_number,
            season_number,
            state: state
        };

        node.meta = newMeta;
        writeJSON(FILES_JSON, allFiles);
        
        res.json({ success: true, node });

    } catch (error: any) {
        console.error("Update Meta Error:", error.message);
        res.status(500).json({ error: "Update failed", details: error.message });
    }
};

// 4. GET Directory/Files
export const getFiles = (req: Request, res: Response) => {
    const { uuid } = req.query;
    const allFiles = readJSON(FILES_JSON) || [];
    
    if (!uuid) return res.json(allFiles);

    const node = findNodeByUUID(allFiles, uuid as string);
    if (!node) return res.status(404).json({ error: "Not found" });

    if (node.type === 'directory') res.json(node.children || []);
    else res.json(node);
};

// 5. GET Media List (Filtered)
export const getMediaList = (req: Request, res: Response) => {
    const { search, genre, year, country } = req.query;
    const allFiles = readJSON(FILES_JSON) || [];
    let list = flattenFiles(allFiles);

    list = list.filter(f => f.meta && (f.meta.type === 'movie' || f.meta.type === 'tv'));

    if (search) {
        const s = (search as string).toLowerCase();
        list = list.filter(f => f.name.toLowerCase().includes(s) || f.meta?.title.toLowerCase().includes(s));
    }
    if (genre) list = list.filter(f => f.meta?.genres.includes(genre as string));
    if (year) list = list.filter(f => f.meta?.year === year);
    if (country) list = list.filter(f => f.meta?.countries.includes(country as string));

    res.json(list);
};

const parseTimemark = (timemark: string): number => {
    const parts = timemark.split(':');
    return (+parts[0]) * 60 * 60 + (+parts[1]) * 60 + (+parts[2]);
};

// 6. GET Extract Embed Subtitles (With SSE Progress)
export const extractSubtitles = (req: Request, res: Response) => {
    const { uuid } = req.params;
    const allFiles = readJSON(FILES_JSON);
    const node = findNodeByUUID(allFiles, uuid);

    if (!node || node.type !== 'file') return res.status(404).json({ error: "File not found" });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ status: "start", message: "Analyzing file..." })}\n\n`);

    ffmpeg(node.path).ffprobe((err, data) => {
        if (err) {
            res.write(`data: ${JSON.stringify({ status: "error", message: "FFprobe failed" })}\n\n`);
            return res.end();
        }

        const duration = data.format.duration || 0;
        const subStreams = data.streams.filter(s => s.codec_type === 'subtitle');

        if (subStreams.length === 0) {
            res.write(`data: ${JSON.stringify({ status: "done", message: "No subtitles found", extracted: [] })}\n\n`);
            return res.end();
        }

        const command = ffmpeg(node.path);
        const results: any[] = [];

        subStreams.forEach((stream, idx) => {
            const lang = stream.tags?.language || 'und';
            const title = stream.tags?.title || `Track ${idx}`;
            const safeLang = lang.replace(/[^a-zA-Z0-9]/g, ""); 
            
            const fileName = `${uuid}_track${idx}_${safeLang}.srt`;
            const outPath = path.join(process.cwd(), 'temp', fileName);

            command.output(outPath).outputOptions([`-map 0:${stream.index}`]);

            results.push({
                label: `Embedded ${lang.toUpperCase()} - ${title}`,
                language: lang,
                path: outPath,
                isEmbedded: true
            });
        });

        command.on('progress', (p) => {
            let percent = 0;
            if (p.percent) {
                percent = p.percent;
            } else if (p.timemark && duration > 0) {
                const currentSeconds = parseTimemark(p.timemark);
                percent = (currentSeconds / duration) * 100;
            }
            
            const payload = JSON.stringify({ 
                status: "progress", 
                percent: Math.min(Math.round(percent), 99)
            });
            res.write(`data: ${payload}\n\n`);
        })
        .on('end', () => {
            res.write(`data: ${JSON.stringify({ status: "done", percent: 100, extracted: results })}\n\n`);
            res.end();
        })
        .on('error', (err) => {
            console.error("Extract error", err);
            res.write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
            res.end();
        })
        .run();
    });
};

// 7. PUT Update Subtitle List
export const updateSubtitles = (req: Request, res: Response) => {
    const { uuid } = req.params;
    const { label, language, extractedPath } = req.body
    
    const allFiles = readJSON(FILES_JSON);
    const node = findNodeByUUID(allFiles, uuid);
    if (!node) return res.status(404).json({ error: "Node not found" });

    if (!node.subtitles) node.subtitles = [];

    if (req.file) {
        node.subtitles.push({
            label: label || req.file.originalname,
            language: language || 'unknown',
            path: req.file.path
        });
    } 
    else if (extractedPath) {
        node.subtitles.push({
            label: label || 'Extracted',
            language: language || 'unknown',
            path: extractedPath
        });
    }

    writeJSON(FILES_JSON, allFiles);
    res.json(node);
};

// 8. GET Download File
export const downloadFile = (req: Request, res: Response) => {
    const { uuid } = req.params;
    const allFiles = readJSON(FILES_JSON);
    const node = findNodeByUUID(allFiles, uuid);

    if (!node || node.type !== 'file') return res.status(404).json({ error: "File not found" });
    res.download(node.path);
};

// 9. GET Download Directory (Zip)
export const downloadDir = (req: Request, res: Response) => {
    const { uuid } = req.params;
    const allFiles = readJSON(FILES_JSON);
    const node = findNodeByUUID(allFiles, uuid);

    if (!node || node.type !== 'directory') return res.status(404).json({ error: "Directory not found" });

    const zipName = `${node.name}.zip`;
    const zipPath = path.join(process.cwd(), 'temp', zipName);
    
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        res.download(zipPath, zipName, (err) => {
            if (!err) fs.unlink(zipPath, () => {});
        });
    });

    archive.pipe(output);
    archive.directory(node.path, false);
    archive.finalize();
};

export const createZip = (req: Request, res: Response) => {
    const { uuid } = req.params;
    const allFiles = readJSON(FILES_JSON);
    const node = findNodeByUUID(allFiles, uuid);

    if (!node || node.type !== 'directory') return res.status(404).json({ error: "Directory not found" });

    const tempDir = path.join(process.cwd(), 'temp');
    const zipName = `${uuid}.zip`;
    const zipPath = path.join(tempDir, zipName);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });

    let isCompleted = false;
    let totalBytes = node.size || 1;

    res.write(`data: ${JSON.stringify({ status: "start", message: "Starting compression..." })}\n\n`);

    archive.on('progress', (progress) => {
        const processed = progress.fs.processedBytes;
        const percent = (processed / totalBytes) * 100;
        
        res.write(`data: ${JSON.stringify({ 
            status: "progress", 
            percent: Math.min(Math.round(percent), 99),
            processed: processed
        })}\n\n`);
    });

    output.on('close', () => {
        if (!isCompleted) {
            isCompleted = true;
            const finalSize = archive.pointer();
            res.write(`data: ${JSON.stringify({ 
                status: "done", 
                percent: 100, 
                downloadUrl: `/api/download/temp/${zipName}`,
                size: finalSize
            })}\n\n`);
            res.end();
        }
    });

    archive.on('error', (err) => {
        console.error("Zip Error:", err);
        if (!isCompleted) {
            res.write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
            res.end();
        }
    });

    req.on('close', () => {
        if (!isCompleted) {
            console.log(`User disconnected. Aborting zip for ${uuid}...`);
            
            archive.abort(); 
            
            fs.unlink(zipPath, (err) => {
                if (err) console.error("Error deleting partial zip:", err);
                else console.log("Partial zip deleted.");
            });
            
            res.end();
        }
    });

    archive.pipe(output);
    archive.directory(node.path, false);
    archive.finalize();
};

// 9B. Download Generated Zip (Langkah 2)
export const downloadCreatedZip = (req: Request, res: Response) => {
    const { filename } = req.params;
    const filePath = path.join(process.cwd(), 'temp', filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File expired or not found" });
    }

    res.download(filePath, filename, (err) => {
        if (!err) {
            fs.unlink(filePath, (e) => {
                if(e) console.error("Failed to delete temp zip:", e);
            });
        }
    });
};

// 10. Streaming
let activeStreams = 0;
const MAX_STREAMS = 3;

export const streamVideo = (req: Request, res: Response) => {
    const { uuid } = req.params;
    
    if (activeStreams >= MAX_STREAMS) return res.status(503).send("Too many active streams");

    const allFiles = readJSON(FILES_JSON);
    const node = findNodeByUUID(allFiles, uuid);

    if (!node || node.type !== 'file') return res.status(404).send("File not found");

    const filePath = node.path;
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.mp4' || ext === '.webm' || ext === '.ogg' || ext === '.m4v') {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;
        const contentType = mime.lookup(filePath) || 'video/mp4';

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            
            activeStreams++;
            res.on('close', () => { activeStreams--; });

            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
                'Content-Disposition': 'inline', 
            };
            
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Content-Disposition': 'inline',
            };
            res.writeHead(200, head);
            fs.createReadStream(filePath).pipe(res);
        }
    } 
    
    else {
        let startTime = 0;
        if (req.query.start) {
            startTime = parseInt(req.query.start as string);
            if (isNaN(startTime)) startTime = 0;
        }

        console.log(`Streaming ${node.name} starting at ${startTime}s (Transcoding Mode)`);
        activeStreams++;

        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Disposition': 'inline',
        });

        const command = ffmpeg(filePath)
            .seekInput(startTime) 
            .videoCodec('libx264') 
            .audioCodec('aac') 
            .format('mp4')             
            .outputOptions([
                '-movflags frag_keyframe+empty_moov', 
                '-preset ultrafast',
                '-tune zerolatency',
                '-crf 28',
                '-max_muxing_queue_size 1024' 
            ])
            .on('error', (err) => {
                if (!err.message.includes('Output stream closed')) {
                    console.error('Streaming error:', err.message);
                }
                activeStreams--;
            })
            .on('end', () => {
                activeStreams--;
            });

        res.on('close', () => {
            command.kill('SIGKILL');
            activeStreams--;
        });

        command.pipe(res, { end: true });
    }
};

// NEW: GET List Extracted Subtitles in Temp Folder
export const getTempSubtitles = (req: Request, res: Response) => {
    const { uuid } = req.params;
    const tempDir = path.join(process.cwd(), 'temp');

    try {
        if (!fs.existsSync(tempDir)) {
            return res.json([]); 
        }

        const files = fs.readdirSync(tempDir);
        const relatedFiles = files.filter(f => f.startsWith(uuid) && f.endsWith('.srt'));

        const results = relatedFiles.map(filename => {
            const parts = filename.split('_');
            let lang = 'unknown';
            let track = '?';

            if (parts.length >= 3) {
                lang = parts[parts.length - 1].replace('.srt', '');
                track = parts[parts.length - 2].replace('track', '');
            }

            return {
                filename: filename,
                extractedPath: path.join(tempDir, filename),
                label: `Extracted Track ${track} (${lang})`,
                language: lang
            };
        });

        res.json(results);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to read temp directory" });
    }
};