const fs = require("fs");
const validator = require("validator");
const { GraphQLUpload } = require("graphql-upload");
const { getVideoDurationInSeconds } = require('get-video-duration');

const { clearMedia } = require("../utils/file");

const Course = require("../models/course");
const Lecture = require("../models/lecture");

const storeFS = ({ stream, filename }) => {
  const uploadDir = "images";
  const newFilename = new Date().getTime() + "-" + filename;
  const path = `${uploadDir}/${newFilename}`;

  return new Promise((resolve, reject) =>
    stream
      .on("error", error => {
        if (stream.truncated)
          // delete the truncated file
          fs.unlinkSync("./" + path);
        reject(error);
      })
      .pipe(fs.createWriteStream("./" + path))
      .on("error", error => reject(error))
      .on("finish", () => resolve({ path }))
  );
};

const validateCourseInput = courseInput => {
  const errors = [];
  if (validator.isEmpty(courseInput.title)) {
    errors.push({ message: "Title is required." });
  }
  if (validator.isEmpty(courseInput.subtitle)) {
    errors.push({ message: "Subtitle is required." });
  }
  if (validator.isEmpty(courseInput.description)) {
    errors.push({ message: "Description is required." });
  }
  if (validator.isEmpty(courseInput.price.toString())) {
    errors.push({ message: "Price is required." });
  }
  if (errors.length > 0) {
    const error = new Error("Invalid input.");
    error.data = errors;
    error.code = 422;
    throw error;
  }
}

module.exports = {
  Upload: GraphQLUpload,

  courses: async function() {
    const courses = await Course.find().sort({ createdAt: -1 });
    return courses.map(c => {
      return {
        ...c._doc,
        _id: c._id.toString()
      };
    });
  },

  createCourse: async function({ courseInput }, req) {
    validateCourseInput(courseInput);

    const { filename, mimetype, createReadStream } = await courseInput.image;
    const stream = createReadStream();
    const pathObj = await storeFS({ stream, filename });
    const fileLocation = pathObj.path;

    const course = new Course({
      ...courseInput,
      imageUrl: fileLocation,
      sections: await this.saveSectionsData(courseInput.sections)
    });

    const createdCourse = await course.save();
    return {
      ...createdCourse._doc,
      _id: createdCourse._id.toString(),
      createdAt: createdCourse.createdAt.toISOString(),
      updatedAt: createdCourse.updatedAt.toISOString()
    };
  },

  saveSectionsData: async function(sections) {
    // saving lectures
    for (const section of sections) {
      for (const lecture of section.lectures) {
        const savedLecture = await this.saveLecture(lecture);
        lecture.id = savedLecture.id;
      }
    }
    // saving sections
    const mappedSections = sections.map(section => {
      return {
        ...section,
        lectures: section.lectures.map(lecture => {
          return lecture.id ? lecture.id : null // save lecture ids only
        })
      }
    });

    return mappedSections;
  },

  saveLecture: async function(lecture) {
    let lectureDocument;
    if (lecture.id) {
      lectureDocument = await Lecture.findById(lecture.id);
      if (!lectureDocument) {
        const error = new Error('No lecture found with ID ' + lecture.id);
        error.code = 404;
        throw error;
      }
    } else {
      lectureDocument = new Lecture();
    }

    const oldVideoUrl = lectureDocument.videoUrl;
    lectureDocument.title = lecture.title;
    lectureDocument.type = lecture.type;
    lectureDocument.videoUrl = lecture.videoUrl;
    lectureDocument.text = lecture.text;
    lectureDocument.isFree = lecture.isFree;
    if (! lectureDocument.duration || oldVideoUrl !== lecture.videoUrl) {
      lectureDocument.duration = Math.round(await getVideoDurationInSeconds(lecture.videoUrl));
    }
    const savedLecture = await lectureDocument.save();

    if (oldVideoUrl && oldVideoUrl !== lecture.videoUrl) {
      clearMedia(oldVideoUrl);
    }

    return savedLecture;
  },

  course: async function({ id }, req) {
    const course = await Course.findById(id).populate('sections.lectures');
    return course;
  },

  updateCourse: async function({ id, courseInput }, req) {
    const course = await Course.findById(id);
    if (!course) {
      const error = new Error('No course found');
      error.code = 404;
      throw error;
    }

    validateCourseInput(courseInput);

    course.title = courseInput.title;
    course.subtitle = courseInput.subtitle;
    course.description = courseInput.description;
    course.price = courseInput.price;
    course.sections = await this.saveSectionsData(courseInput.sections);

    const uploadedImage = await courseInput.image;
    let oldImageUrl = null;
    if (uploadedImage) {
      oldImageUrl = course.imageUrl;
      const { filename, mimetype, createReadStream } = uploadedImage;
      const stream = createReadStream();
      const pathObj = await storeFS({ stream, filename });
      const fileLocation = pathObj.path;
      course.imageUrl = fileLocation;
    }

    await course.save();
    const updatedCourse = await Course.findById(id).populate('sections.lectures');
    if (oldImageUrl !== updatedCourse.imageUrl) {
      clearMedia(oldImageUrl);
    }

    return {
      ...updatedCourse._doc,
      _id: updatedCourse._id.toString(),
      createdAt: updatedCourse.createdAt.toISOString(),
      updatedAt: updatedCourse.updatedAt.toISOString()
    };
  },

  deleteCourse: async function({ id }, req) {
    const course = await Course.findById(id).populate('sections.lectures');
    if (!course) {
      const error = new Error('No course found');
      error.code = 404;
      throw error;
    }
    await Course.findByIdAndRemove(id);
    clearMedia(course.imageUrl);
    // delete all video files of the course
    for (const section of course.sections)
      for (const lecture of section.lectures) {
        clearMedia(lecture.videoUrl);
      }
    return true;
  },

  deleteSection: async function({ id, courseId }, req) {
    const course = await Course.findById(courseId).populate('sections.lectures');
    if (!course) {
      const error = new Error('No course found');
      error.code = 404;
      throw error;
    }
    const sectionIndex = course.sections.findIndex(section => section.id.toString() === id);
    if (sectionIndex < 0) {
      const error = new Error('No section found');
      error.code = 404;
      throw error;
    }
    const section = course.sections.splice(sectionIndex, 1);
    await course.save();
    // delete all video files of the section
    for (const lecture of section.lectures) {
      clearMedia(lecture.videoUrl);
    }
    return true;
  },

  deleteLecture: async function({ id }, req) {
    const lecture = await Lecture.findById(id);
    await Lecture.findByIdAndRemove(id);
    clearMedia(lecture.videoUrl);
    return true;
  },
};
