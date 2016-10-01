/******************************************************
** See the accompanying README and LICENSE files
** Author(s): Jeremy Magland
** Created: 10/1/2016
*******************************************************/

#include "prvgui.h"

#include <QColor>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QProcess>
#include <taskprogress.h>

QString to_string(fuzzybool fb)
{
    if (fb == YES)
        return "YES";
    if (fb == NO)
        return "x";
    return ".";
}

QColor to_color(fuzzybool fb)
{
    if (fb == YES)
        return Qt::darkGreen;
    if (fb == NO)
        return Qt::darkRed;
    return ".";
}

QString to_prv_code(PrvRecord prv)
{
    return prv.checksum + ":" + QString("%1").arg(prv.size);
}

void PrvGuiWorkerThread::run()
{
    TaskProgress task("Searching");
    results.clear();
    for (int i = 0; i < prvs.count(); i++) {
        task.setProgress((i + 0.5) / prvs.count());
        if (QThread::currentThread()->isInterruptionRequested())
            return;
        PrvRecord prv = prvs[i];
        QString prv_code = to_prv_code(prv);
        QString name = QFileInfo(prv.original_path).fileName();
        long size = prv.size;
        {
            task.log() << "check if on local disk" << name << size;
            QString local_path = check_if_on_local_disk(prv);
            results[prv_code].local_path = local_path;
            {
                QMutexLocker locker(&results_mutex);
                if (!local_path.isEmpty())
                    results[prv_code].on_local_disk = YES;
                else
                    results[prv_code].on_local_disk = NO;
            }
            emit results_updated();
        }
        foreach (QString server_name, server_names) {
            task.log() << "check if on server" << name << server_name;
            if (QThread::currentThread()->isInterruptionRequested())
                return;
            QString server_url = check_if_on_server(prv, server_name);
            results[prv_code].server_urls[server_name] = server_url;
            {
                QMutexLocker locker(&results_mutex);
                if (!server_url.isEmpty())
                    results[prv_code].on_server[server_name] = YES;
                else
                    results[prv_code].on_server[server_name] = NO;
            }
            emit results_updated();
        }
    }
}

QString exec_process_and_return_output(QString cmd, QStringList args)
{
    QProcess P;
    P.setReadChannelMode(QProcess::MergedChannels);
    P.start(cmd, args);
    P.waitForStarted();
    P.waitForFinished(-1);
    return P.readAll();
}

QString PrvGuiWorkerThread::check_if_on_local_disk(PrvRecord prv)
{
    QString cmd = "prv";
    QStringList args;
    args << "locate";
    args << "--checksum=" + prv.checksum;
    args << "--checksum1000=" + prv.checksum1000;
    args << QString("--size=%1").arg(prv.size);
    args << "--local-only";
    QString output = exec_process_and_return_output(cmd, args);
    return output;
}

QString PrvGuiWorkerThread::check_if_on_server(PrvRecord prv, QString server_name)
{
    QString cmd = "prv";
    QStringList args;
    args << "locate";
    args << "--checksum=" + prv.checksum;
    args << "--checksum1000=" + prv.checksum1000;
    args << QString("--size=%1").arg(prv.size);
    args << "--server=" + server_name;
    QString output = exec_process_and_return_output(cmd, args);
    return output;
}

QList<PrvRecord> find_prvs(QString label, const QJsonValue& X)
{
    QList<PrvRecord> ret;
    if (X.isObject()) {
        QJsonObject obj = X.toObject();
        if ((obj.contains("original_checksum")) && (obj.contains("original_size"))) {
            ret << PrvRecord(label, obj);
            return ret;
        }
        else {
            QStringList keys = obj.keys();
            foreach (QString key, keys) {
                QString label0 = key;
                if (label0 == "data")
                    label0 = label;
                ret.append(find_prvs(label0, obj[key]));
            }
            return ret;
        }
    }
    else if (X.isArray()) {
        QJsonArray array = X.toArray();
        for (int i = 0; i < array.count(); i++) {
            ret.append(find_prvs(label + QString("[%1]").arg(i), array[i]));
        }
        return ret;
    }
    else {
        return ret;
    }
}

PrvProcessRecord::PrvProcessRecord(QJsonObject obj)
{
    QJsonObject inputs = obj["inputs"].toObject();
    QJsonObject outputs = obj["outputs"].toObject();

    this->processor_name = obj["processor_name"].toString();
    this->processor_version = obj["processor_version"].toString();
    this->parameters = obj["parameters"].toObject().toVariantMap();

    QStringList ikeys = inputs.keys();
    foreach (QString ikey, ikeys) {
        PrvRecord rec(ikey, inputs[ikey].toObject());
        this->inputs << rec;
    }

    QStringList okeys = outputs.keys();
    foreach (QString okey, okeys) {
        PrvRecord rec(okey, outputs[okey].toObject());
        this->outputs << rec;
    }
}

QVariantMap PrvProcessRecord::toVariantMap() const
{
    QVariantMap ret;

    QVariantList inputs0;
    foreach (PrvRecord inp, this->inputs) {
        inputs0 << inp.toVariantMap();
    }

    QVariantList outputs0;
    foreach (PrvRecord out, this->outputs) {
        outputs0 << out.toVariantMap();
    }

    ret["processor_name"] = processor_name;
    ret["processor_version"] = processor_version;
    ret["inputs"] = inputs0;
    ret["outputs"] = outputs0;
    ret["parameters"] = this->parameters;

    return ret;
}

PrvProcessRecord PrvProcessRecord::fromVariantMap(QVariantMap X)
{
    PrvProcessRecord ret;

    ret.processor_name = X["processor_name"].toString();
    ret.processor_version = X["processor_version"].toString();
    {
        QVariantList list = X["inputs"].toList();
        foreach (QVariant item, list) {
            ret.inputs << PrvRecord::fromVariantMap(item.toMap());
        }
    }
    {
        QVariantList list = X["outputs"].toList();
        foreach (QVariant item, list) {
            ret.outputs << PrvRecord::fromVariantMap(item.toMap());
        }
    }
    ret.parameters = X["parameters"].toMap();

    return ret;
}

PrvRecord::PrvRecord(QString label_in, QJsonObject obj)
{
    this->original_object = obj;
    this->label = label_in;
    this->original_path = obj["original_path"].toString();
    this->checksum = obj["original_checksum"].toString();
    this->checksum1000 = obj["original_checksum_1000"].toString();
    this->size = obj["original_size"].toVariant().toLongLong();

    QJsonArray X = obj["processes"].toArray();
    foreach (QJsonValue val, X) {
        QJsonObject P = val.toObject();
        this->processes << PrvProcessRecord(P);
    }
}

QVariantMap PrvRecord::toVariantMap() const
{
    QVariantMap ret;

    ret["label"] = this->label;

    ret["checksum"] = this->checksum;
    ret["checksum1000"] = this->checksum1000;
    ret["size"] = (long long)this->size;
    ret["original_path"] = this->original_path;

    QVariantList processes0;
    foreach (PrvProcessRecord P, this->processes) {
        processes0 << P.toVariantMap();
    }
    ret["processes"] = processes0;

    return ret;
}

PrvRecord PrvRecord::fromVariantMap(QVariantMap X)
{
    QJsonObject obj;
    obj["original_checksum"] = X["checksum"].toString();
    obj["original_checksum_1000"] = X["checksum1000"].toString();
    obj["original_size"] = X["size"].toLongLong();
    obj["original_path"] = X["original_path"].toString();
    PrvRecord ret(X["label"].toString(), obj);

    QList<PrvProcessRecord> processes0;
    QVariantList list = X["processes"].toList();
    foreach (QVariant P, list) {
        processes0 << PrvProcessRecord::fromVariantMap(P.toMap());
    }

    ret.processes = processes0;

    return ret;
}
