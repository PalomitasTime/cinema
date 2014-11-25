var _               = require('underscore');
var WebTorrent      = require('webtorrent');
var fs              = require('fs');
var path            = require('path');
var parseTorrent    = require('parse-torrent');
var sha256          = require('sha256');
var express         = require('express');

process.chdir(__dirname);

var app = express();
app.use(express.static('./public'));

var server = app.listen(parseInt(process.env.CINEMA_PORT) || 8000);

var io = require('socket.io')(server);

var webTorrent = new WebTorrent();

function getFirstMovieFile(torrentFiles) {
    return _.first(_.filter(torrentFiles, function(file) {
        return /^.+\.(mp4|webm|ogg|avi|mov|mkv)$/.test(file.name);
    }));
}

app.get('/stream/:infoHash', function(req, res) {
    if (req.method !== 'GET') {
        res.writeHead(405, {
            'Allow': 'GET',
            'Content-Type': 'text/plain',
        });
        res.end("Method not allowed");
        return;
    }

    var torrent = _.first(_.filter(webTorrent.torrents, function(torrent) {
        return torrent.infoHash === req.params.infoHash;
    }));

    var movieFile = getFirstMovieFile(torrent.files);

    if (!movieFile) {
        res.writeHead(404, {
            'Content-Type': 'text/plain',
        });
        res.end("File not found");
        return;
    }

    var contentType = 'video/mp4';
    var range = req.headers.range;
    var length = movieFile.length;

    if (range) {
        var groups = _.compact(/^bytes=(\d+)-(\d+)?$/.exec(range));

        var start = 0;
        var end = length - 1;
        var chunkSize = (end - start) + 1;

        if (groups.length >= 3) {
            start = parseInt(groups[1]);
            end = parseInt(groups[2]);
            chunkSize = (end - start) + 1;
        }

        var contentRange = start + '-' + end + '/' + length;

        res.writeHead(206, {
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType,
            'Content-Range': 'bytes ' + contentRange,
            'Content-Length': chunkSize,
        });
        movieFile.createReadStream({ start: start, end: end }).pipe(res);

        console.log('HTTP 206 – Range:', contentRange);
    } else {
        // Warning: Streaming the whole file at once will
        // consume a lot of memory.

        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': length,
        });
        movieFile.createReadStream().pipe(res);

        console.log('HTTP 200 – All:', length);
    }
});

io.on('connection', function(socket) {

    console.log('Client with id <' + socket.id + '> connected.');

    function emitStatistics() {
        io.sockets.emit('statistics', {
            streamers: Object.keys(io.sockets.adapter.rooms).length,
            torrents: webTorrent.torrents.length,
        });
    }

    emitStatistics();

    socket.on('disconnect', function() {
        emitStatistics();

        console.log('Client with id <' + socket.id + '> disconnected.');
    });

    socket.on('torrent', function(data) {
        if (!parseTorrent(data.torrentId)) {
            return;
        }

        var torrent = webTorrent.get(data.torrentId);

        if (torrent) {
            console.log('Torrent with info hash "' + torrent.infoHash + '" found.');
            streamMovie(torrent);
            return;
        }

        webTorrent.add(data.torrentId, function(torrent) {
            console.log('Torrent with info hash "' + torrent.infoHash + '" added.');
            streamMovie(torrent);
        });

        function streamMovie(torrent) {
            var movieFile = getFirstMovieFile(torrent.files);

            if (!movieFile) {
                console.error('No suitable movie file found.');
                socket.emit('error message', {
                    message: "No suitable movie file was found in the torrent.",
                });
                webTorrent.remove(data.torrentId);
                return;
            }

            var movieFileExt = getFileExtension(movieFile.name);

            if (!_.contains(['mp4'], movieFileExt)) {
                console.error('Unsupported format "' + movieFileExt + '".');
                socket.emit('error message', {
                    message: movieFileExt.toUpperCase() + " video files are currently not supported. Please pick a torrent with an MP4 video file instead."
                });
                webTorrent.remove(data.torrentId);
                return;
            }

            socket.emit('play', {
                videoLink: '/stream/' + torrent.infoHash,
            });

            console.log('<' + socket.id + '>', 'is streaming', movieFile.name);

            emitStatistics();
        }

        function getFileExtension(fileName) {
            return /^.+\.([a-z0-9]+)$/.exec(fileName)[1];
        }
    });

});