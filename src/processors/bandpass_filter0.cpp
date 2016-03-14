#include "bandpass_filter0.h"
#include "diskreadmda.h"

#include <diskwritemda.h>
#include <mstimeserieschunker.h>

Mda do_bandpass_filter0(Mda &X);

bool bandpass_filter0(const QString &input_path, const QString &output_path, double sampling_freq, double freq_min, double freq_max)
{
	long chunk_size=100;
	long overlap_size=10;
	DiskReadMda X(input_path);
	long M=X.N1();
	long N=X.N2();

	DiskWriteMda Y(MDAIO_TYPE_FLOAT32,output_path,M,N);

	Mda chunk;
	long timepoint=0;
	while (timepoint<N) {
		X.getSubArray(chunk,0,timepoint-overlap_size,M,chunk_size+2*overlap_size);
		chunk=do_bandpass_filter0(chunk);
		Mda chunk2;
		chunk.getSubArray(chunk2,0,overlap_size,M,chunk_size);
		Y.writeSubArray(chunk2,0,timepoint);
		timepoint+=chunk_size;
	}

	return true;
}

Mda do_bandpass_filter0(Mda &X) {
	long M=X.N1();
	long N=X.N2();
	Mda Y(M,N);
	double *Xptr=X.dataPtr();
	double *Yptr=Y.dataPtr();

	long aaa=0;
	for (long n=0; n<N; n++) {
		for (long m=0; m<M; m++) {
			Yptr[aaa]=Xptr[aaa]*2;
			aaa++;
		}
	}

	return Y;
}
