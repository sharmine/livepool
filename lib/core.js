var http = require('http'),
    https = require('https'),
    httpProxy = require('http-proxy'),
    fs = require('fs'),
    net = require('net'),
    path = require('path'),
    _ = require('underscore'),
    iconv = require("iconv-lite"),
    zlib = require('zlib');
// db,sequelize,models.
var db = require("../../helios-service-nodejs/lib/db");
var model = require("../../helios-service-nodejs/lib/model");

// http://www.onicos.com/staff/iz/amuse/javascript/expert/utf.txt

/* utf.js - UTF-8 <=> UTF-16 convertion
 *
 * Copyright (C) 1999 Masanao Izumo <iz@onicos.co.jp>
 * Version: 1.0
 * LastModified: Dec 25 1999
 * This library is free.  You can redistribute it and/or modify it.
 */

// function Decodeuint8arr(uint8array){
//     return new TextDecoder("utf-8").decode(uint8array);
// }

function Utf8ArrayToStr(array) {
    var out, i, len, c;
    var char2, char3;

    out = "";
    len = array.length;
    i = 0;
    while (i < len) {
        c = array[i++];
        switch (c >> 4) {
            case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
                // 0xxxxxxx
                out += String.fromCharCode(c);
                break;
            case 12: case 13:
                // 110x xxxx   10xx xxxx
                char2 = array[i++];
                out += String.fromCharCode(((c & 0x1F) << 6) | (char2 & 0x3F));
                break;
            case 14:
                // 1110 xxxx  10xx xxxx  10xx xxxx
                char2 = array[i++];
                char3 = array[i++];
                out += String.fromCharCode(((c & 0x0F) << 12) |
                    ((char2 & 0x3F) << 6) |
                    ((char3 & 0x3F) << 0));
                break;
        }
    }

    return out;
}


function uint8arrayToStringMethod(myUint8Arr) {
    return String.fromCharCode.apply(null, myUint8Arr);
}
/**
 * self module requirement
 * @param  {string} module module name
 * @return {object}        livepool singleton
 */

function liveRequire(module) {
    return livepool[module] = require('./livepool/' + module);
};

// livepool module init
var livepool = module.exports = {};
livepool.verson = '0.7.2';
livepool.startTime = (new Date()).getTime();

// self module require
var config = liveRequire('config'),
    logger = liveRequire('logger'),
    util = liveRequire('util'),
    eventCenter = liveRequire('event'),
    request = liveRequire('request'),
    notify = liveRequire('notify'),
    proxy = liveRequire('proxy'),
    response = liveRequire('response');

var responders = require('./livepool/responder');

var global = config.global,
    httpPort = global.http,
    httpsPort = global.https,
    uiport = global.uiport,
    proxyAgent = global.proxy || '',
    proxyAgent = proxyAgent.split(':'),
    localName = '127.0.0.1';

// global 
var httpServer, httpsServer, https2http;
var liveapp;
// request session id seed
var idx = 0;

var ssl = {
    key: fs.readFileSync('keys/key.pem'),
    cert: fs.readFileSync('keys/cert.pem')
};

var proxy2Liveapp = new httpProxy.createProxyServer({
    target: {
        host: localName,
        port: uiport
    }
});

function runLiveApp() {
    liveapp = require('./webui/liveapp').app.run();
};

function loadPlugins() {
    require('./plugins/nocache').run(livepool);
};

livepool.run = function () {
    logger.writeline();
    logger.log('livepool'.cyan + ' is running, port: ' + String(httpPort).cyan);

    // 加载替换和路由规则
    config.loadRules();

    // 加载插件
    loadPlugins();

    // 初始化webui
    runLiveApp();

    // 设置系统全局代理
    if (config.settings.proxy) {
        proxy.setProxy(httpPort);
    }
    var fillImgsAndVideoZuiyou = function(item,target){
        if (item.imgs && item.imgs.length > 0) {
            // 保存图片？
            // console.log(item.imgs);
            target.imgs = JSON.stringify(item.imgs);
            target.type = "IMAGE";
        }
        // 特么的videos不是数组，是对象。。。
        if (item.videos) {
            // 保存视频？
            target.videos = JSON.stringify(item.videos);
            target.type = "VIDEO";
        }
    }

    // http proxy server
    httpServer = http.createServer(function (req, res) {
        var responder;
        var reqInfo = request.getReqInfo(req);
        var handler = config.getHandler(reqInfo);
        var reqUrl = reqInfo.url;
        var hostname = reqInfo.headers.host.split(':')[0];
        var sid = ++idx;
        var chunks = [];
        var options = {
            sid: sid
        };
        var callback = function (err, body) {
            notify.response(sid, req, res, body);
        };

        // notify req
        notify.request(sid, req, res);
        response.getResInfo(res);
        // parse post body
        if (req.method == 'POST') {
            var body = '';
            req.on('data', function (data) {
                body += data;
            });
            req.on('end', function () {
                notify.reqBody(sid, req, res, body);
                // console.log(uint8arrayToStringMethod(body));
            });
        }

        res.on('pipe', function (readStream) {
            // readStream = response.getResInfo(readStream);
            readStream.on('data', function (chunk) {
                chunks.push(chunk);
                res.write(chunk);
            });
            readStream.on('end', function () {
                var headers = readStream.headers || [];
                var buffer = Buffer.concat(chunks);
                var encoding = headers['content-encoding'];

                // console.log(uint8arrayToStringMethod(buffer));
                var iszuiyou = false;
                if (/.*izuiyou.*/.exec(req.url)) {
                    // console.log("encoding is:"+encoding);
                    iszuiyou = true;
                }

                if (encoding == 'gzip') {
                    zlib.gunzip(buffer, function (err, decoded) {
                        if (iszuiyou) {
                            var listResult = (JSON.parse(iconv.decode(decoded.toString('binary'), "utf-8")));
                            console.log(listResult);
                            var list = listResult.data.list;
                            if (list) {
                                for (var i in list) {
                                    var item = list[i];
                                    if (item.adslot) {
                                        continue;
                                    }
                                    if(!item["_id"])continue;
                                    var topic = { content: item.content, votesCount: item.likes ,source:"zuiyou",originalJson:JSON.stringify(item)};
                                    // 填充图片和视频
                                    fillImgsAndVideoZuiyou(item,topic);
                                    
                                    model.Topics.findOrCreate({where:{remoteId:item["_id"],source:"zuiyou"},defaults:topic}).spread(function (result, created) {
                                        // console.log(result);
                                        
                                        
                                            // if (item.god_reviews && item.god_reviews.length > 0) {
                                            //     for (var i in item.god_reviews) {
                                            //         if (item.god_reviews.hasOwnProperty(i)) {
                                            //             var comment = item.god_reviews[i];
                                            //             // save comments.
                                            //             var commentObj = {
                                            //                 topicId: result.id,
                                            //                 content:comment.review,
                                            //             };
                                            //             fillImgsAndVideoZuiyou(comment,commentObj);
                                            //             model.Comments.create(commentObj);
                                            //         }
                                            //     }
                                            // }
                                 
                                    }).error(function (err){
                                        console.log(err);
                                    });

                                }
                            }

                        }
                        callback(err, decoded && decoded.toString('binary'));
                    });
                } else if (encoding == 'deflate') {
                    zlib.inflate(buffer, function (err, decoded) {
                        callback(err, decoded && decoded.toString('binary'));
                    });
                } else {
                    callback(null, buffer.toString('binary'));
                }
            });
        });

        if (reqUrl.match(/127.0.0.1:8002/)) {
            // ui app
            proxy2Liveapp.web(req, res);
        } else if ((hostname != 'localhost') && handler && (responder = responders[handler.respond.type])) {
            // local replacement
            logger.log('req handler [ ' + handler.respond.type.grey + ' ]: ' + reqUrl.grey);
            responder(handler, req, res, options);
        } else {
            // remote route
            responder = responders['route'];
            responder(null, req, res, options);
        }

    });
    httpServer.setMaxListeners(0);
    httpServer.listen(httpPort);

    // directly forward https request
    // TODO support https responders
    httpServer.on('connect', function (req, cltSocket, head) {
        // connect to an origin server
        var prefix = "http://";
        if (/:443/.exec(req.url)) {
            prefix = "https://";
        }
        var srvUrl = require('url').parse(prefix + req.url);
        var iszuiYou = false;
        // console.log(req.url);
        if (req.url.match(/.*izuiyou.*/g)) {
            // console.log("zuiyou!!!");
            // console.log(req.url);
            // console.log(req);
            iszuiYou = true;

        }
        var srvSocket = net.connect(srvUrl.port, srvUrl.hostname, function () {
            if (iszuiYou) {
                srvSocket.on("error", function (err) {
                    // console.log("error!");
                    // console.log(err);
                    // console.log(srvUrl);
                });
                srvSocket.on('data', function (chunk) {
                    // console.log('read %d bytes: %s', chunk.length, chunk);

                    // console.log(uint8arrayToStringMethod(chunk));
                });
            }
            cltSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                'Proxy-agent: LivePool-Proxy\r\n' +
                '\r\n');
            srvSocket.write(head);
            srvSocket.pipe(cltSocket);
            cltSocket.pipe(srvSocket);
        });

    });

    // directly forward websocket 
    // TODO support websocket responders
    httpServer.on('upgrade', function (req, socket, head) {
        socket.write('HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
            'Upgrade: WebSocket\r\n' +
            'Connection: Upgrade\r\n' +
            '\r\n');

        socket.pipe(socket); // echo back
    });
};

// stop server
livepool.stop = function () {
    if (httpSever) {
        httpSever.close();
    }
};

livepool.run();
