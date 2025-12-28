import { Router } from 'express';
import multer from 'multer';
import * as ctrl from './controllers';

const router = Router();
const upload = multer({ dest: 'uploads/' });

router.put('/root-drive', ctrl.setRootDrive);               
router.get('/sync', ctrl.syncFiles);                       
router.put('/meta/:uuid', ctrl.updateMeta);                 
router.get('/files', ctrl.getFiles);                        
router.get('/media', ctrl.getMediaList);                    
router.get('/subtitles/temp/:uuid', ctrl.getTempSubtitles);
router.get('/subtitles/extract/:uuid', ctrl.extractSubtitles); 
router.put('/subtitles/:uuid', upload.single('subtitle'), ctrl.updateSubtitles); 
router.get('/download/file/:uuid', ctrl.downloadFile);      
router.get('/download/dir/:uuid', ctrl.downloadDir);        
router.get('/zip/create/:uuid', ctrl.createZip)
router.get('/download/temp/:filename', ctrl.downloadCreatedZip);
router.get('/stream/:uuid', ctrl.streamVideo);        

export default router;