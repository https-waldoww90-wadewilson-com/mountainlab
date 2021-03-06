#!/usr/bin/env nodejs

var common=require('./common.js');
var os=require('os');

exports.spec=function() {
	var spec0={};
	spec0.name='mountainsort.ms2_sorting';
	spec0.version='0.1';

	spec0.inputs=[
        {name:"raw",description:"raw timeseries (M x N)",optional:true},
        {name:"clips",description:"The event clips to be sorted",optional:false},
        {name:"event_times",descript:"The timestamps for the events",optional:false},
        {name:"amplitudes",description:"The amplitudes of the events to go in the firings file",optional:true}
    ];
    spec0.outputs=[
        {name:"firings_out",description:"The labeled events (3 x L)"},
        {name:"cluster_metrics_out",description:"",optional:true}
    ];

	spec0.parameters=[];
	spec0.parameters.push({name:'segment_duration_sec'});
	spec0.parameters.push({name:'num_intrasegment_threads',optional:true});
	spec0.parameters.push({name:'num_intersegment_threads',optional:true});
	spec0.parameters.push({name:"samplerate",description:"sample rate for timeseries"});
	spec0.parameters.push({name:"central_channel",optional:true});
	spec0.parameters.push({name:"freq_min",optional:true},{name: "freq_max",optional:true},{name: "freq_wid",optional:true});
	spec0.parameters.push({name:"clip_size_msec",optional:true});
	spec0.parameters.push({name:"consolidate_clusters",optional:true},{name:"fit_stage",optional:true});
	return common.clone(spec0);
};

exports.run=function(opts,callback) {
	var tmpfiles=[]; //all the temporary files to get removed at the end
	opts.temp_prefix=opts.temp_prefix||'00'; //in case the user has specified the temp_prefix
	opts.num_intrasegment_threads=Number(opts.num_intrasegment_threads||1); //number of segments to process simultaneously
	opts.num_intersegment_threads=opts.num_intersegment_threads||0; //number of threads to use within each segment
	if (!opts.num_intersegment_threads) {
		// determine whether to use multi-threading within each segment
		// depending on whether we are doing intrasegment threads
		if (opts.num_intrasegment_threads<=1)
			opts.num_intersegment_threads=os.cpus().length;
		else
			opts.num_intersegment_threads=1;
	}
	if (!opts._tempdir) {
		console.error('opts._tempdir is empty'); //we need a _tempdir to store all the temporary files
		process.exit(-1);
	}
	if (!opts.samplerate) {
		console.error('opts.samplerate is zero or empty');
		process.exit(-1);	
	}
	if (!opts.segment_duration_sec) {
		console.error('opts.segment_duration_sec is zero or empty');
		process.exit(-1);		
	}

	var steps=[]; //the processing steps
	var info={}; //the info about the size of the arrays
	var segments=[];
	var all_event_times=mktmp('all_event_times.mda'); //across all segments
	var all_amplitudes=mktmp('all_amplitudes.mda'); //across all segments
	var whitening_matrix=mktmp('whitening_matrix.mda'); //for entire dataset
	var all_clips=mktmp('all_clips.mda'); //across all segments (subsampled collection)
	var all_whitened_clips=mktmp('all_whitened_clips.mda'); //clips are whitened rather than timeseries
	var all_labels=mktmp('all_labels.mda'); //across all segments
	//var all_labels2=mktmp('all_labels.mda'); //consolidated
	var all_firings=mktmp('all_firings.mda'); //across all segments
	var all_firings_fit=mktmp('all_firings_fit.mda'); //after fit stage

	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//get the info about the size of the concatenated dataset
		read_info_from_input_files(function() {
			cb();
		});		
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//bandpass filter each segment
		//detect events for each segment
		process1_segments(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//combine all the event times
		combine_event_times(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//combine all the event amplitudes
		combine_amplitudes(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//extract all the clips (subsampled collection)
		extract_all_clips(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//compute a single whitening matrix for entire dataset
		compute_whitening_matrix(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//apply the whitening matrix to all the clips
		whiten_all_clips(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//the actual clustering
		sort_all_whitened_clips(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//create firings file
		STEP_create_firings(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//fit stage
		process2_segments(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//get the cluster metrics
		cluster_metrics(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//write output files
		write_output_files(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////
	steps.push(function(cb) {
		//remove the temporary files
		cleanup(function() {
			cb();
		});
	});
	///////////////////////////////////////////////////////////////

	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////
	//Run all steps
	common.foreach(steps,{},function(ii,step,cb) {
		console.log ('');
		console.log ('--------------------------- SORTING STEP '+(ii+1)+' of '+steps.length +' -----------');
		var timer=new Date();
		step(function() {
			console.log ('SORTING STEP '+(ii+1)+': Elapsed time (sec): '+get_elapsed_sec(timer));
			cb();
		});
	},function() {
		callback();
	});
	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////

	function process1_segments(process1_segments_callback) {
		var process1_steps=[];
		var segment_duration=Math.ceil(opts.segment_duration_sec*opts.samplerate);
		segments=create_segments(info.N,segment_duration,segment_duration);
		if (segments.length===0) {
			console.log ('Error: no segments created (N='+info.N+')');
			process.exit(-1);
		}
		for (var iseg=0; iseg<segments.length; iseg++) {
			add_process1_step(iseg);
		}
		function add_process1_step(iseg) {
			var segment=segments[iseg];
			segment.timeseries0=mktmp('timeseries_segment_'+iseg+'.mda'); //will be removed after event times obtained
			segment.filt0=mktmp('filt_segment_'+iseg+'.mda'); //will be removed after clips extracted
			segment.event_times0=mktmp('event_times0_segment_'+iseg+'.mda');
			segment.event_times1=mktmp('event_times1_segment_'+iseg+'.mda'); //after applying timestamp offset
			segment.amplitudes0=mktmp('amplitudes_segment_'+iseg+'.mda'); //the amplitudes corresponding to the event times
			var intersegment_steps=[];
			process1_steps.push(function(cb) {
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Extracting timeseries for segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					extract_segment_timeseries(opts.raw,segment.timeseries0,segment.t1,segment.t2,function() {
						cb2();
					});
				});
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Bandpass filter for segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					bandpass_filter(segment.timeseries0,segment.filt0,function() {
						cb2();
					});
				});
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Detect events for segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					detect_events(segment.filt0,segment.event_times0,function() {
						cb2();
					});
				});
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Compute amplitudes for segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					compute_amplitudes(segment.filt0,segment.event_times0,opts.central_channel||0,segment.amplitudes0,function() {
						cb2();
					});
				});
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Applying timestamp offset for events in segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					apply_timestamp_offset(segment.event_times0,segment.event_times1,segment.t1,function() {
						//save disk space by removing filt0 and timeseries0!
						common.remove_temporary_files([segment.timeseries0],function() {
							cb2();
						});
					});
				});
				//Run all intersegment steps
				common.foreach(intersegment_steps,{num_parallel:1},function(ii,step0,cb0) {
					var timer=new Date();
					step0(function() {
						cb0();
					});
				},function() {
					cb();
				});
			});
		}
		//Run all process1 steps
		common.foreach(process1_steps,{num_parallel:opts.num_intrasegment_threads},function(ii,step,cb) {
			console.log ('');
			console.log ('--------------------------- PROCESS1 SEGMENT '+(ii+1)+' of '+process1_steps.length +' -----------');
			var timer=new Date();
			step(function() {
				console.log ('Elapsed time for process1 '+(ii+1)+' of '+(process1_steps.length)+' (sec): '+get_elapsed_sec(timer));
				cb();
			});
		},function() {
			process1_segments_callback();
		});
	}

	function process2_segments(process2_segments_callback) {
		var process2_steps=[];
		for (var iseg=0; iseg<segments.length; iseg++) {
			add_process2_step(iseg);
		}
		function add_process2_step(iseg) {
			var segment=segments[iseg];
			segment.firings0=mktmp('firings_segment_'+iseg+'.mda');
			segment.pre0=mktmp('pre_segment_'+iseg+'.mda');
			segment.firings_fit0=mktmp('firings_fit0_segment_'+iseg+'.mda');
			segment.firings_fit1=mktmp('firings_fit1_segment_'+iseg+'.mda'); //after timestamp offset applied
			var intersegment_steps=[];
			process2_steps.push(function(cb) {
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Extracting firings for segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					extract_segment_firings(all_firings,segment.firings0,segment.t1,segment.t2,function() {
						cb2();
					});
				});
				/*
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Whitening segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					whiten_timeseries(segment.filt0,whitening_matrix,segment.pre0,function() {
						cb2();
					});
				});
				*/
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Fit stage for segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					fit_stage(segment.filt0,segment.firings0,segment.firings_fit0,function() {
						cb2();
					});
					/*
					fit_stage(segment.pre0,segment.firings0,segment.firings_fit0,function() {
						cb2();
					});
					*/
				});
				intersegment_steps.push(function(cb2) {
					console.log ('>>>>>>>>>>>> Applying timestamp offsets for segment '+(iseg+1)+' ('+segment.t1+','+segment.t2+')...\n');	
					apply_timestamp_offset(segment.firings_fit0,segment.firings_fit1,segment.t1,function() {
						cb2();
					});
				});
				//Run all intersegment steps
				common.foreach(intersegment_steps,{num_parallel:1},function(ii,step0,cb0) {
					var timer=new Date();
					step0(function() {
						cb0();
					});
				},function() {
					cb();
				});
			});
		}
		//Run all process2 steps
		common.foreach(process2_steps,{num_parallel:opts.num_intrasegment_threads},function(ii,step,cb) {
			console.log ('');
			console.log ('--------------------------- PROCESS2 SEGMENT '+(ii+1)+' of '+process2_steps.length +' -----------');
			var timer=new Date();
			step(function() {
				console.log ('Elapsed time for process2 '+(ii+1)+' of '+(process2_steps.length)+' (sec): '+get_elapsed_sec(timer));
				cb();
			});
		},function() {
			var firings_fit_list=[];
			for (var iseg=0; iseg<segments.length; iseg++) {
				firings_fit_list.push(segments[iseg].firings_fit1);
			}
			common.mp_exec_process('mountainsort.concat_firings',
				{firings_list:firings_fit_list},
				{firings_out:all_firings_fit},
				{},
				process2_segments_callback
			);
			
		});
	}

	function apply_timestamp_offset(firings,firings_out,timestamp_offset,callback) {
		common.mp_exec_process('mountainsort.apply_timestamp_offset',
			{firings:firings},
			{firings_out:firings_out},
			{timestamp_offset:timestamp_offset},
			callback
		);
	}

	function combine_event_times(combine_event_times_callback) {
		console.log ('-------------------- COMBINING EVENT TIMES -------------------');
		var event_times_list=[];
		for (var ii in segments) {
			var segment=segments[ii];
			event_times_list.push(segment.event_times1);
		}
		common.mp_exec_process('mountainsort.concat_event_times',
			{event_times_list:event_times_list},
			{event_times_out:all_event_times},
			{},
			combine_event_times_callback
		);
	}

	function combine_amplitudes(combine_amplitudes_callback) {
		console.log ('-------------------- COMBINING AMPLITUDES -------------------');
		var amplitudes_list=[];
		for (var ii in segments) {
			var segment=segments[ii];
			amplitudes_list.push(segment.amplitudes0);
		}
		common.mp_exec_process('mountainsort.concat_event_times', //a hack, use the same processor
			{event_times_list:amplitudes_list},
			{event_times_out:all_amplitudes},
			{},
			combine_amplitudes_callback
		);
	}

	function extract_all_clips(extract_all_clips_callback) {
		console.log ('-------------------- EXTRACTING ALL CLIPS -------------------');
		var clip_size=Math.ceil(opts.clip_size_msec/1000*opts.samplerate);
		var filt_list=[];
		for (var ii in segments) {
			var segment=segments[ii];
			filt_list.push(segment.filt0);
		}
		common.mp_exec_process('mountainsort.extract_clips',
			{timeseries:filt_list,event_times:all_event_times},
			{clips_out:all_clips},
			{clip_size:clip_size},
			extract_all_clips_callback
		);
	}

	function compute_whitening_matrix(compute_whitening_matrix_callback) {
		console.log ('-------------------- COMPUTING WHITENING MATRIX -------------------');
		var filt_list=[];
		for (var ii in segments) {
			var segment=segments[ii];
			filt_list.push(segment.filt0);
		}
		common.mp_exec_process('mountainsort.compute_whitening_matrix',
			{timeseries_list:filt_list},
			{whitening_matrix_out:whitening_matrix},
			{_request_num_threads:opts.num_intrasegment_threads||1},
			compute_whitening_matrix_callback
		);	
	}

	function whiten_all_clips(whiten_all_clips_callback) {
		console.log ('-------------------- WHITENING ALL CLIPS -------------------');
		common.mp_exec_process('mountainsort.whiten_clips',
			{clips:all_clips,whitening_matrix:whitening_matrix},
			{clips_out:all_whitened_clips},
			{_request_num_threads:opts.num_intrasegment_threads||1},
			whiten_all_clips_callback
		);	
	}	

	/*
	function whiten_timeseries(ts,wm,ts_out,whiten_timeseries_callback) {
		console.log ('-------------------- WHITENING TIMESERIES -------------------');
		common.mp_exec_process('mountainsort.apply_whitening_matrix',
			{timeseries:ts,whitening_matrix:wm},
			{timeseries_out:ts_out},
			{_request_num_threads:opts.num_intersegment_threads||1},
			whiten_timeseries_callback
		);	
	}
	*/	

	function sort_all_whitened_clips(sort_all_whitened_clips_callback) {
		console.log ('-------------------- SORTING WHITENED CLIPS -------------------');
		common.mp_exec_process('mountainsort.sort_clips',
			{clips:all_whitened_clips},
			{labels_out:all_labels},
			{_request_num_threads:opts.num_intrasegment_threads||1},
			sort_all_whitened_clips_callback
		);	
	}

	function STEP_create_firings(create_firings_callback) {
		console.log ('-------------------- CREATING FIRINGS -------------------');
		common.mp_exec_process('mountainsort.create_firings',
			{event_times:all_event_times,labels:all_labels,amplitudes:all_amplitudes},
			{firings_out:all_firings},
			{central_channel:opts.central_channel},
			create_firings_callback
		);	
	}		

	function fit_stage(timeseries,firings,firings_out,callback) {
		common.mp_exec_process('mountainsort.fit_stage',
			{timeseries:timeseries,firings:firings},
			{firings_out:firings_out},
			{
			},
			callback
		);
	}

	function write_output_files(write_output_files_callback) {
		common.copy_file(all_firings_fit,opts.firings_out,function() {
			{
				write_output_files_callback();
			}
		});
	}

	function cluster_metrics(cluster_metrics_callback) {
		////////////////////////////////////////////////////////
		//cluster metrics
		if (opts.cluster_metrics_out) {
			console.log ('>>>>> Cluster metrics -> '+opts.cluster_metrics_out);
			common.mp_exec_process('mountainsort.cluster_metrics',
					{timeseries:opts.raw,firings:all_firings_fit},
					{cluster_metrics_out:opts.cluster_metrics_out},
					{samplerate:opts.samplerate},
					function() {
						cluster_metrics_callback();
						//done
					}
			);
		}
		else {
			cluster_metrics_callback();
			//done
		}
	}

	function cleanup(callback) {
		common.remove_temporary_files(tmpfiles,callback);
	}

	function bandpass_filter(timeseries,timeseries_out,callback) {
		common.mp_exec_process('mountainsort.bandpass_filter',
			{timeseries:timeseries},
			{timeseries_out:timeseries_out},
			{
				samplerate:opts.samplerate,
				freq_min:opts.freq_min||0,
				freq_max:opts.freq_max||0,
				freq_wid:opts.freq_wid||0,
				//testcode:'noread,nowrite',
				_request_num_threads:opts.num_intersegment_threads||1
			},
			callback
		);
	}

	function detect_events(timeseries,event_times_out,callback) {
		var detect_interval=Math.ceil(opts.detect_interval_msec/1000*opts.samplerate);
		common.mp_exec_process('mountainsort.detect_events',
			{timeseries:timeseries},
			{event_times_out:event_times_out},
			{
				central_channel:opts.central_channel,
				detect_threshold:opts.detect_threshold,
				detect_interval:detect_interval,
				sign:opts.detect_sign,
				subsample_factor:opts.subsample_factor||1,
				_request_num_threads:opts.num_intersegment_threads||1	
			},
			callback
		);
	}

	function compute_amplitudes(timeseries,event_times,central_channel,amplitudes_out,callback) {
		common.mp_exec_process('mountainsort.compute_amplitudes',
			{timeseries:timeseries,event_times:event_times},
			{amplitudes_out:amplitudes_out},
			{
				central_channel:central_channel,
				_request_num_threads:opts.num_intersegment_threads||1
			},
			callback
		);	
	}

	function consolidate_clusters(clips,labels,labels_out,callback) {
		common.mp_exec_process('mountainsort.consolidate_clusters',
			{clips:clips,labels:labels},
			{labels_out:labels_out},
			{
				central_channel:opts.central_channel,
				_request_num_threads:opts.num_intersegment_threads||1
			},
			callback
		);
	}
	
	
	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////
	
	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////


// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //

	

	function mktmp(name) {
		var temp_prefix=opts._temp_prefix||'00';
		var path=opts._tempdir+'/'+temp_prefix+'-'+name;
		tmpfiles.push(path);
		return path;
	}

	function read_info_from_input_files(callback) {
		console.log('----==========================---------------- '+opts.raw);
		if (typeof(opts.raw)!='object') {
			common.read_mda_header(opts.raw,function (header) { // Read the .mda header for the timeseries
				info.M=header.dims[0];
				info.N=header.dims[1];
				callback();
			});
		}
		else {
			get_header_for_concatenation_of_timeseries(opts.raw,function(header) {
				info.M=header.dims[0];
				info.N=header.dims[1];
				callback();
			});
		}
	}

	function extract_segment_timeseries(ts_in,ts_out,t1,t2,callback) {
		common.mp_exec_process('mountainsort.extract_segment_timeseries',
			{timeseries:ts_in},
			{timeseries_out:ts_out},
			{t1:t1,t2:t2},
			callback
		);
	}

	function extract_segment_firings(firings_in,firings_out,t1,t2,callback) {
		common.mp_exec_process('mountainsort.extract_segment_firings',
			{firings:firings_in},
			{firings_out:firings_out},
			{t1:t1,t2:t2},
			callback
		);
	}
};

function get_elapsed_sec(timer) {
	var stamp=new Date();
	return (stamp-timer)/1000;
}

function create_segments(N,segment_size,shift_size) {
	var ret=[];
	for (var i=0; i<N; i+=shift_size) {
		var t1=i,t2=t1+segment_size-1;
		if (t2>=N) {
			t2=N-1
			ret.push({t1:t1,t2:t2});
			break;
		}
		else {
			ret.push({t1:t1,t2:t2});
		}
	}
	return ret;
}

function get_header_for_concatenation_of_timeseries(ts_list,callback) {
	if (ts_list.length==0) {
		console.error('ts_list is empty.');
		process.exit(-1);
	}
	common.read_mda_header(ts_list[0],function(header0) {
		console.log('########### '+JSON.stringify(header0));
		header0.dims[1]=0;
		common.foreach(ts_list,{},function(ii,ts,cb) {
			common.read_mda_header(ts,function(header1) {
				header0.dims[1]+=header1.dims[1];
				cb();
			});
		},function() {
			callback(header0);
		});
	});
	
}
